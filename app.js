/**
 * OpenCase v5 — браузерное казино (vanilla JS)
 *
 * АРХИТЕКТУРА ДЛЯ МИГРАЦИИ НА REACT:
 * ─────────────────────────────────────────────────────────────
 * config/
 *   game.config.js     ← CONFIG (SPIN_COST, RARITY_WEIGHT, ...)
 *   slots.config.js    ← SLOT_CONFIG (WIN_THRESHOLD, PAYOUTS, ...)
 *   coin.config.js     ← COIN_CONFIG (HOUSE_EDGE, ...)
 *   items.js           ← ITEMS[], RARITY_LABEL, RARITY_COLOR
 *   ui-text.js         ← UI_TEXT (все строки интерфейса)
 *
 * store/  (zustand)
 *   useGameStore.js    ← balance, stats, history, sound, save/load
 *   useCaseStore.js    ← isSpinning, stripItems, lastFinalX
 *   useSlotsStore.js   ← isSlotSpinning, slotBet, reelState
 *   useCoinStore.js    ← coinFlipping, coinBet, playerChoice, streak
 *
 * hooks/
 *   useSave.js         ← loadSave, writeSave, migrateSave, валидация
 *   useAudio.js        ← AudioContext, playTone, playWinSound, playCoinFlip
 *   useConfetti.js     ← launchConfetti
 *   useTopup.js        ← topupToday, topupDate, updateTopupBtn, daily limit
 *
 * utils/
 *   shuffle.js         ← Fisher-Yates shuffle
 *   caseWeights.js     ← computeWeights, getPrize, buildStrip
 *   slotRng.js         ← generateSlotResults (чистая ф-я, легко тестировать)
 *
 * components/
 *   TopBar/            ← баланс, звук, кнопка сброса, топап
 *   GameTabs/          ← переключение игр, ARIA навигация
 *   games/
 *     CaseGame/        ← spinRoulette, лента, пул, шансы
 *     SlotsGame/       ← createSlotReels, spinReel (GSAP через useRef)
 *     CoinGame/        ← flipCoin, streak, выбор стороны
 *   ui/
 *     HistoryPanel/
 *     StatsPanel/
 *     OddsPanel/
 *     LegendaryOverlay/
 *     ConfirmModal/
 *     Notification/
 *
 * ВАЖНО ПРИ МИГРАЦИИ:
 *   • GSAP: все gsap.to/set/fromTo → через useGSAP() хук + refs
 *   • AudioContext: создавать в useEffect после user gesture
 *   • localStorage: через zustand persist middleware
 *   • Stripe-анимация кейса — самая сложная часть (~40% работы)
 * ─────────────────────────────────────────────────────────────
 */
(function(){
  // MODULE: config/game.config
  // ========== КОНФИГ ==========
  const CONFIG = {
    // Fix-1: SPIN_COST поднят с 50 до 130₽
    // E[выигрыш] = 97.06₽ → RTP = 97.06/130 ≈ 74.7% (было 194% при 50₽)
    SPIN_COST: 130,
    START_BALANCE: 2600,    // 20 спинов на старте
    SITE_BALANCE: 10000,    // резерв казино под выплаты
    TOPUP_AMOUNT: 1300,     // пополнение = 10 спинов
    TOPUP_DAILY_LIMIT: 5,    // #fix1: макс. пополнений в сутки (иначе игрок никогда не банкротится)
    
    RARITY_WEIGHT: { common: 55, rare: 25, epic: 12, legendary: 8 },
    
    SPIN_DURATION: 4.0,       // #fix13 UX: было 7.5с — слишком долго ждать проигрыш
    SPIN_EASE_START: 'power2.inOut',
    SPIN_EASE_END: 'power3.out',
    SWAP_DELAY: 500,           // уменьшено пропорционально SPIN_DURATION 4.0с
    MIN_SPINS: 4,             // уменьшено пропорционально новой длительности
    EXTRA_SPINS: 2,
    
    STRIP_COPIES: 8,
    ITEMS_PER_COPY: 10,   // карточек на копию ленты; STRIP_COPIES × ITEMS_PER_COPY = полная длина ленты
    MAX_HISTORY: 18,
    
    MAX_PAYOUT_RATIO: 0.9,
    DAILY_BONUS: 200,         // ежедневный бонус при повторном визите
  };

  // MODULE: config/slots.config
  // ========== КОНФИГ СЛОТОВ ==========
  const SLOT_CONFIG = {
    SYMBOL_HEIGHT: 150,
    TOTAL_SYMBOLS_PER_REEL: 30,
    MIN_SPINS: 3,
    EXTRA_SPINS: 3,
    REEL_DURATIONS: [2.5, 3.0, 3.5],
    PAYOUTS: {
      '7️⃣': 10,
      '💎': 8,
      '👑': 5,
    },
    // Fix-9: метки типов выигрыша вынесены в конфиг — при добавлении нового символа
    // достаточно добавить запись сюда, а не менять цепочку тернарников в логике
    WIN_LABELS: {
      '7️⃣': 'ДЖЕКПОТ',
      '💎': 'БРИЛЛИАНТЫ',
      '👑': 'КОРОЛЬ',
    },
    WIN_LABEL_DEFAULT: 'СЕТ',
    WIN_LABEL_PAIR: 'ПАРА',   // GD-6 fix: вынесено из хендлера в конфиг
    DEFAULT_PAYOUT_TRIPLE: 3,
    // RTP слотов: E = WIN_THRESHOLD*(TRIPLE_SHARE*avg_triple_mult+(1-TRIPLE_SHARE)*PAIR_PAYOUT)
    // avg_triple_mult = (10+8+5+3+3+3)/6 = 5.333
    // WIN_THRESHOLD = 0.75 / (0.025*5.333 + 0.975*1.5) = 0.75/1.5958 ≈ 0.47 → RTP=75%
    WIN_THRESHOLD: 0.47,
    TRIPLE_SHARE: 0.025,      // доля тройников из выигрышных; остальное — пары
    PAIR_PAYOUT: 1.5,
    CONFETTI_WIN_THRESHOLD: 200,
    CONFETTI_BIG_THRESHOLD: 500,
  };

  // MODULE: config/coin.config
  // ========== КОНФИГ ОРЁЛ/РЕШКА ==========
  const COIN_CONFIG = {
    WIN_MULTIPLIER: 2,      // x2 к ставке при выигрыше
    HOUSE_EDGE: 0.23,       // GSN-1 fix: 23% → RTP = (0.5-0.115)*2 = 77% ≈ RTP кейса/слотов
    FLIP_DURATION: 2000,    // мс анимации
    TICK_COUNT: 14,         // количество тиков при броске
  };
  const ITEMS = [
    { id: 'c1', name: 'Грязный носок', price: 3, rarity: 'common', icon: '🧦' },
    { id: 'c2', name: 'Жвачка из-под парты', price: 5, rarity: 'common', icon: '🫧' },
    { id: 'c3', name: 'Сломанная зажигалка', price: 7, rarity: 'common', icon: '🔥' },
    { id: 'c4', name: 'Ржавый гвоздь', price: 4, rarity: 'common', icon: '📌' },
    { id: 'c5', name: 'Пустая банка колы', price: 6, rarity: 'common', icon: '🥤' },
    { id: 'c6', name: 'Чей-то выпавший зуб', price: 8, rarity: 'common', icon: '🦷' },
    { id: 'c7', name: 'Сломанные наушники', price: 12, rarity: 'common', icon: '🎧' },
    { id: 'c8', name: 'Окурок', price: 2, rarity: 'common', icon: '🚬' },
    { id: 'c9', name: 'Просроченный йогурт', price: 9, rarity: 'common', icon: '🥛' },
    { id: 'c10', name: 'Сломанные очки', price: 15, rarity: 'common', icon: '👓' },
    
    { id: 'r1', name: 'Золотая монета', price: 45, rarity: 'rare', icon: '🪙' },
    { id: 'r2', name: 'Стальной ключ', price: 65, rarity: 'rare', icon: '🔑' },
    { id: 'r3', name: 'Череп крысы', price: 35, rarity: 'rare', icon: '🐀' },
    { id: 'r4', name: 'Странная таблетка', price: 25, rarity: 'rare', icon: '💊' },
    { id: 'r5', name: 'Сломанный айфон', price: 85, rarity: 'rare', icon: '📱' },
    
    { id: 'e1', name: 'Хрустальный череп', price: 150, rarity: 'epic', icon: '💀' },
    { id: 'e2', name: 'Лампа с джинном', price: 240, rarity: 'epic', icon: '🪔' },
    { id: 'e3', name: 'Сапоги-скороходы', price: 170, rarity: 'epic', icon: '👢' },
    { id: 'e4', name: 'Магический кристалл', price: 260, rarity: 'epic', icon: '🔮' },
    
    { id: 'l1', name: 'Посох Всевластия', price: 450, rarity: 'legendary', icon: '🪄' },
    { id: 'l2', name: 'Молот Тора', price: 800, rarity: 'legendary', icon: '🔨' },
    { id: 'l3', name: 'Яйцо дракона', price: 550, rarity: 'legendary', icon: '🥚' },
    { id: 'l4', name: 'Чаша Грааля', price: 990, rarity: 'legendary', icon: '🏆' },
  ];

  // Все строки UI — в одном месте для будущей i18n/локализации
  const RARITY_LABEL = { common:'Обычный', rare:'Редкий', epic:'Эпик', legendary:'Легенда' };
  const UI_TEXT = {
    spinBtn:        (cost) => `КРУТИТЬ · ${cost}₽`,
    slotBtn:        (cost) => `🎰 КРУТИТЬ · ${cost}₽`,
    coinBtn:        (cost) => `🪙 БРОСИТЬ · ${cost}₽`,
    resultIdle:     '⚡ ЖМИ НА КНОПКУ',
    resultSpin:     '🌀 ВРАЩЕНИЕ...',
    resultNoFunds:  '😔 Недостаточно средств',
    coinIdle:       '⚡ ВЫБЕРИ ОРЁЛ ИЛИ РЕШКУ',
    coinFlying:     '🪙 Монета летит...',
    eagleChosen:    '🦅 Орёл выбран — ставь и бросай!',
    tailsChosen:    '₽ Решка выбрана — ставь и бросай!',
    slotIdle:       '⚡ ВЫБЕРИ СТАВКУ',
    historyEmpty:   'Пока ничего...',
    casinoRefill:   '🏦 Казино получило инвестиции!',
    dailyBonus:     (n) => `🎁 Ежедневный бонус: +${n}₽! Возвращайся каждый день!`,
    topupLimit:     (n) => `⛔ Лимит пополнений: ${n} в сутки исчерпан`,
    storageWarn:    '⚠️ Сохранение недоступно — прогресс не сохранится (режим инкогнито?)',
  };
  const RARITY_COLOR = { common:'#7a8a9c', rare:'#2f80ed', epic:'#bb6bd9', legendary:'#f2c94c' };
  const WIN_SOUNDS = {
    legendary: [523, 659, 784, 1047],
    epic: [440, 554, 659],
    rare: [392, 494],
    common: [330],
  };

  // MODULE: hooks/useSave
  // ========== ПЕРСИСТЕНТНОСТЬ ==========
  const STORAGE_KEY = 'opencase_save';
  const SAVE_VERSION = 4; // bumped: добавлены lastVisit, topupToday, topupDate

  // #fix19: миграция сохранений между версиями — игрок не теряет прогресс при обновлении
  function migrateSave(raw) {
    if (!raw) return null;
    // v3 → v4: добавляем новые поля с дефолтами
    if (raw.version === 3) {
      raw.version    = 4;
      raw.lastVisit  = null;
      raw.topupToday = 0;
      raw.topupDate  = null;
      return raw;
    }
    return null; // неизвестная версия — не мигрируем
  }

  const VALID_BETS = [10, 25, 50, 100];
  const isFinPos  = v => typeof v === 'number' && isFinite(v) && v >= 0;

  // Fix-2: валидация stats — все поля числа, иначе дефолт
  function validateStats(s) {
    const defaults = {
      totalSpins: 0, legendaryHits: 0, totalSpent: 0, totalWon: 0,
      coinStreak: 0, coinStreakBest: 0, eagleWins: 0, tailsWins: 0,
      caseSpent: 0, caseWon: 0, slotsSpent: 0, slotsWon: 0, coinSpent: 0, coinWon: 0,
    };
    if (!s || typeof s !== 'object') return defaults;
    const result = {};
    for (const [key, def] of Object.entries(defaults)) {
      const v = s[key];
      result[key] = (typeof v === 'number' && isFinite(v)) ? v : def;
    }
    return result;
  }

  // Fix-2: полная санитизация загруженного сохранения
  function validateSave(raw) {
    if (!raw || raw.version !== SAVE_VERSION) return null;
    if (!isFinPos(raw.playerBalance) || !isFinPos(raw.siteBalance)) return null;
    return {
      playerBalance: raw.playerBalance,
      siteBalance:   raw.siteBalance,
      winHistory:    Array.isArray(raw.winHistory)
                       ? raw.winHistory.slice(0, CONFIG.MAX_HISTORY)
                       : [],
      soundEnabled:  typeof raw.soundEnabled === 'boolean' ? raw.soundEnabled : true,
      slotBet:       VALID_BETS.includes(raw.slotBet) ? raw.slotBet : 25,
      coinBet:       VALID_BETS.includes(raw.coinBet) ? raw.coinBet : 25,
      lastVisit:     typeof raw.lastVisit === 'string' ? raw.lastVisit : null,
      topupToday:    typeof raw.topupToday === 'number' ? raw.topupToday : 0,
      topupDate:     typeof raw.topupDate  === 'string' ? raw.topupDate  : null, // #fix1: дата последнего топапа
      stats:         validateStats(raw.stats),
    };
  }

  function loadSave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      let parsed = JSON.parse(raw);
      // #fix19: пробуем мигрировать если версия устарела
      if (parsed && parsed.version !== SAVE_VERSION) {
        parsed = migrateSave(parsed);
      }
      return parsed ? validateSave(parsed) : null;
    } catch(e) { return null; }
  }

  // #fix21: проверяем доступность localStorage один раз при старте
  let _storageAvailable = true;
  (function checkStorage() {
    try {
      localStorage.setItem('__test__', '1');
      localStorage.removeItem('__test__');
    } catch(e) {
      _storageAvailable = false;
      // покажем предупреждение после инициализации DOM
      document.addEventListener('DOMContentLoaded', () => {
        showNotification(UI_TEXT.storageWarn, 'error');
      }, { once: true });
    }
  })();

  /**
   * Сохраняет текущее состояние игры в localStorage.
   * В React: хук useSave — вызывать через zustand middleware или useEffect
   */
  function writeSave() {
    if (!_storageAvailable) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: SAVE_VERSION, // Fix-2: версия в каждом сохранении
        playerBalance,
        siteBalance,
        stats,
        winHistory,
        soundEnabled,
        slotBet,
        coinBet,
        lastVisit,
        topupToday,
        topupDate,
      }));
    } catch(e) {}
  }

  // MODULE: store/useGameStore
  // ========== СОСТОЯНИЕ ==========
  const _save = loadSave();
  let playerBalance = _save ? _save.playerBalance : CONFIG.START_BALANCE;
  let siteBalance   = _save ? _save.siteBalance   : CONFIG.SITE_BALANCE;
  let isSpinning    = false;
  let isSlotSpinning = false; // Fix-4: отдельный флаг для слотов
  let currentAnim   = null;
  let stripItems    = [];
  let itemWidth     = 0;
  let winHistory    = _save ? _save.winHistory  : [];
  let audioCtx      = null;
  let soundEnabled  = _save ? _save.soundEnabled : true;
  let _lastFinalX   = null;

  let stats = _save ? _save.stats : {
    totalSpins: 0, legendaryHits: 0, totalSpent: 0, totalWon: 0,
    coinStreak: 0, coinStreakBest: 0, eagleWins: 0, tailsWins: 0,
    caseSpent: 0, caseWon: 0, slotsSpent: 0, slotsWon: 0, coinSpent: 0, coinWon: 0,
  };

  // Состояние орёл/решка
  let coinBet = _save?.coinBet ?? 25; // BUG-15 fix
  let playerChoice = null;
  let coinFlipping = false;
  let slotBet = _save?.slotBet ?? 25; // BUG-15 fix (объявление тут, используется ниже)
  // #fix1: счётчик топапов в сутки
  let topupToday = _save?.topupToday ?? 0;
  let topupDate  = _save?.topupDate  ?? null;
  // #fix4: lastVisit теперь в основном сохранении, а не в отдельном ключе
  let lastVisit  = _save?.lastVisit  ?? null;

  // ========== DOM ==========
  const $ = id => document.getElementById(id);
  const itemsStrip      = $('itemsStrip');
  const playerSpan      = $('playerBalance');
  const siteSpan        = $('siteBalance');
  const spinBtn         = $('spinBtn');
  const resultDiv       = $('resultDisplay');
  const historyList     = $('historyList');
  const oddsList        = $('oddsList');
  const topupBtn        = $('topupBtn');
  const topupLabel      = $('topupLabel');
  const confettiCont    = $('confettiContainer');
  const resetBtn        = $('resetBtn');
  const soundToggle     = $('soundToggle');
  const totalSpinsEl    = $('totalSpins');
  const legendaryCountEl= $('legendaryCount');
  const totalSpentEl    = $('totalSpent');
  const totalWonEl      = $('totalWon');
  const winLine         = $('winLine');
  const spinSlotBtn     = $('spinSlotBtn');
  const slotResult      = $('slotResult');
  const rtpEl           = $('rtpValue');
  const slotCostLabel   = $('slotCostLabel');
  const spinCostLabel   = $('spinCostLabel');
  // Орёл/решка
  const coinEl          = $('coin');
  const coinResultEl    = $('coinResult');
  const flipCoinBtn     = $('flipCoinBtn');
  const coinCostLabel   = $('coinCostLabel');
  const coinStreakVal    = $('coinStreakVal');
  const coinStreakIcon   = $('coinStreakIcon');
  // Fix: используем $() как все остальные DOM-элементы (id добавлен в HTML)
  const slotMachineEl   = $('slotMachine');
  const coinMachineEl   = $('coinMachine');

  // MODULE: components/GameTabs
  // ========== TABS ==========
  const tabs = document.querySelectorAll('.tab-button');
  const caseGame  = $('caseGame');
  const slotsGame = $('slotsGame');
  const coinGame  = $('coinGame');
  const oddsPanel = $('oddsPanel');

  const GAME_CONTAINERS = { case: caseGame, slots: slotsGame, coin: coinGame };

  function switchTab(gameKey, noAnim = false) {
    tabs.forEach(t => {
      const active = t.dataset.game === gameKey;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active); // Fix-12
    });
    Object.entries(GAME_CONTAINERS).forEach(([key, el]) => {
      const isActive = key === gameKey;
      el.classList.toggle('active', isActive);
      if (isActive) {
        el.classList.toggle('no-anim', noAnim);
        if (!noAnim) void el.offsetWidth;
      }
    });
    oddsPanel.style.display = gameKey === 'case' ? '' : 'none';
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.game));
  });

  // UX2-06 fix: ARIA tablist требует клавиатурной навигации стрелками
  // Tab+Enter работал, но Arrow-клавиши — нет. Исправлено.
  document.querySelector('.game-tabs').addEventListener('keydown', e => {
    const tabList = Array.from(tabs);
    const currentIdx = tabList.findIndex(t => t.getAttribute('aria-selected') === 'true');
    let nextIdx = currentIdx;
    if (e.key === 'ArrowRight') { nextIdx = (currentIdx + 1) % tabList.length; }
    else if (e.key === 'ArrowLeft') { nextIdx = (currentIdx - 1 + tabList.length) % tabList.length; }
    else if (e.key === 'Home') { nextIdx = 0; }
    else if (e.key === 'End') { nextIdx = tabList.length - 1; }
    else return;
    e.preventDefault();
    switchTab(tabList[nextIdx].dataset.game);
    tabList[nextIdx].focus();
  });

  // Адаптивная высота символа слота (синхронизируется с CSS через MOBILE_BREAKPOINT)
  // Объявлено ПЕРЕД createSlotReels — иначе ReferenceError при вызове getSymbolHeight()
  const MOBILE_BREAKPOINT    = 680;  // совпадает с @media (max-width: 680px) в style.css
  const SYMBOL_HEIGHT_MOBILE = 100;  // совпадает с .reel-symbol { height: 100px } в style.css
  function getSymbolHeight() {
    return window.innerWidth <= MOBILE_BREAKPOINT ? SYMBOL_HEIGHT_MOBILE : SLOT_CONFIG.SYMBOL_HEIGHT;
  }

  // MODULE: components/games/SlotsGame
  // ========== СЛОТ-МАШИНА ==========
  // slotBet объявлен выше вместе с coinBet (BUG-15 fix)
  const slotSymbols = ['🍒', '🍋', '🍊', '7️⃣', '💎', '👑'];
  let reels = [];
  let reelStrips = [];
  let reelSymbolSequences = []; // Bug-fix: храним перемешанный порядок для каждого барабана

  function createSlotReels() {
    const container = $('slotReels');
    container.innerHTML = '';
    reels = [];
    reelStrips = [];
    reelSymbolSequences = []; // Bug-fix: сбрасываем при пересоздании
    
    for (let r = 0; r < 3; r++) {
      const reelContainer = document.createElement('div');
      reelContainer.className = 'reel-container';
      
      const reelWindow = document.createElement('div');
      reelWindow.className = 'reel-window';
      
      const reelStrip = document.createElement('div');
      reelStrip.className = 'reel-strip';
      
      // Bug-fix: сохраняем shuffledSymbols в reelSymbolSequences чтобы spinReel мог
      // искать правильную позицию символа на ленте (а не в исходном неперемешанном массиве)
      // DEV-1 fix: Fisher-Yates вместо biased sort — гарантирует равномерное распределение
      const shuffledSymbols = shuffle([...slotSymbols]);
      reelSymbolSequences.push(shuffledSymbols);

      for (let i = 0; i < SLOT_CONFIG.TOTAL_SYMBOLS_PER_REEL; i++) {
        const symbol = document.createElement('div');
        symbol.className = 'reel-symbol';
        symbol.textContent = shuffledSymbols[i % shuffledSymbols.length];
        reelStrip.appendChild(symbol);
      }
      
      const reelOverlay = document.createElement('div');
      reelOverlay.className = 'reel-overlay';
      
      reelWindow.appendChild(reelStrip);
      reelContainer.appendChild(reelWindow);
      reelContainer.appendChild(reelOverlay);
      container.appendChild(reelContainer);
      
      reels.push(reelContainer);
      reelStrips.push(reelStrip);
      
      // Bug-fix: используем getSymbolHeight() вместо SLOT_CONFIG.SYMBOL_HEIGHT —
      // на мобильных символы 100px, и начальная позиция должна совпадать с границами
      gsap.set(reelStrip, { y: -getSymbolHeight() * Math.floor(Math.random() * 10) });
    }
  }

  createSlotReels();

  // Генерация результата слотов с контролируемым RTP
  // Алгоритм: сначала решаем исход, потом детерминированно выбираем символы
  // RTP = WIN_THRESHOLD * (TRIPLE_SHARE*avg_triple + (1-TRIPLE_SHARE)*PAIR_PAYOUT) ≈ 75%
  /**
   * Генерирует результат слотов с контролируемым RTP.
   * RTP ≈ 75%: WIN_THRESHOLD*(TRIPLE_SHARE*avg_triple+(1-TRIPLE_SHARE)*PAIR_PAYOUT)
   * В React: вынести в utils/slotRng.js (чистая функция)
   * @returns {string[]} массив из 3 символов
   */
  function generateSlotResults() {
    // Детерминированный выбор случайного элемента из массива — без while-loop
    const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
    const pickExcept = (arr, ...excluded) => {
      const pool = arr.filter(s => !excluded.includes(s));
      return pool.length ? pick(pool) : pick(arr); // fallback если pool пуст
    };

    const roll = Math.random();
    if (roll < SLOT_CONFIG.WIN_THRESHOLD) {
      const isTriple = Math.random() < SLOT_CONFIG.TRIPLE_SHARE;
      if (isTriple) {
        const sym = pick(slotSymbols);
        return [sym, sym, sym];
      } else {
        // Пара: два совпадают, третий гарантированно отличается
        const sym   = pick(slotSymbols);
        const other = pickExcept(slotSymbols, sym);
        const pos   = Math.floor(Math.random() * 3);
        const r     = [sym, sym, sym];
        r[pos]      = other;
        return r;
      }
    } else {
      // Проигрыш: все три разные (детерминированно через filter)
      const s1 = pick(slotSymbols);
      const s2 = pickExcept(slotSymbols, s1);
      const s3 = pickExcept(slotSymbols, s1, s2);
      return [s1, s2, s3];
    }
  }

  document.querySelectorAll('[data-slot-bet]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-slot-bet]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      slotBet = parseInt(btn.dataset.slotBet);
      slotCostLabel.textContent = slotBet;
    });
  });

  // Bug-fix: принимает reelSymbols — перемешанная последовательность конкретного барабана,
  // чтобы targetIndex указывал на ячейку с нужным символом (а не на позицию в исходном массиве)
  function spinReel(reelStrip, finalSymbol, duration, reelSymbols) {
    return new Promise(resolve => {
      const { TOTAL_SYMBOLS_PER_REEL, MIN_SPINS, EXTRA_SPINS } = SLOT_CONFIG;
      const SYMBOL_HEIGHT = getSymbolHeight(); // адаптивно под мобильные
      const totalHeight = TOTAL_SYMBOLS_PER_REEL * SYMBOL_HEIGHT;

      // Нормализуем текущую позицию в [-totalHeight, 0]
      const rawY = parseFloat(gsap.getProperty(reelStrip, 'y')) || -SYMBOL_HEIGHT;
      const currentY = ((rawY % totalHeight) - totalHeight) % totalHeight;
      gsap.set(reelStrip, { y: currentY });

      // Найти ближайший экземпляр finalSymbol ВПЕРЁД по ленте
      // Bug-fix: используем reelSymbols (перемешанный порядок барабана), а не slotSymbols
      const currentTopIndex = Math.round(-currentY / SYMBOL_HEIGHT);
      let targetIndex = -1;
      for (let i = 1; i <= TOTAL_SYMBOLS_PER_REEL; i++) {
        const idx = (currentTopIndex + i) % TOTAL_SYMBOLS_PER_REEL;
        if (reelSymbols[idx % reelSymbols.length] === finalSymbol) {
          targetIndex = idx;
          break;
        }
      }
      if (targetIndex === -1) targetIndex = currentTopIndex;

      // targetY в нормализованном пространстве [-totalHeight, 0]
      let targetY = -(targetIndex * SYMBOL_HEIGHT);
      if (targetY > 0) targetY -= totalHeight;
      if (targetY === 0) targetY = -totalHeight;

      // Расстояние до цели вперёд (всегда отрицательное — вниз по числовой оси)
      let delta = targetY - currentY;
      if (delta >= 0) delta -= totalHeight;

      // Добавляем полные обороты для длинной анимации
      const spins = MIN_SPINS + Math.floor(Math.random() * EXTRA_SPINS);
      const totalDelta = delta - spins * totalHeight;

      gsap.to(reelStrip, {
        y: `+=${totalDelta}`,
        duration,
        ease: 'power2.out',
        // modifier держит strip в видимом диапазоне всё время вращения
        modifiers: {
          y: gsap.utils.unitize(v => {
            const n = parseFloat(v);
            return ((n % totalHeight) - totalHeight) % totalHeight;
          }),
        },
        onComplete: () => {
          // После modifier реальный y GSAP != визуальный, фиксируем точную позицию
          gsap.set(reelStrip, { y: targetY });
          resolve(targetIndex); // Fix-6: возвращаем индекс для подсветки выигрышного символа
        }
      });
    });
  }

  spinSlotBtn.addEventListener('click', async () => {
    if (isSlotSpinning) return;
    // GD2-03 / QA2-02 fix: блокируем слоты пока крутится кейс (и наоборот)
    if (isSpinning) {
      showNotification('⏳ Дождись окончания спина кейса');
      return;
    }
    if (coinFlipping) {
      showNotification('⏳ Дождись броска монеты');
      return;
    }
    if (playerBalance < slotBet) {
      showNotification('❌ Недостаточно средств');
      spinSlotBtn.classList.add('btn-broke'); // #fix11: визуальный сигнал
      setTimeout(() => spinSlotBtn.classList.remove('btn-broke'), 1500);
      return;
    }
    // GD-2 fix: проверяем что казино может выплатить максимальный приз слотов
    const maxSlotPayout = slotBet * Math.max(...Object.values(SLOT_CONFIG.PAYOUTS));
    if (siteBalance < maxSlotPayout * 0.5) {
      showNotification('🏦 Казино не в состоянии принять ставку');
      return;
    }

    isSlotSpinning = true; // Fix-4
    setButtonLoading(spinSlotBtn, true);
    // Сбрасываем старые подсветки выигрышных символов
    document.querySelectorAll('.reel-symbol.win-symbol').forEach(s => s.classList.remove('win-symbol'));
    startSlotTicks();

    playerBalance -= slotBet;
    siteBalance += slotBet;
    stats.totalSpent += slotBet;
    stats.slotsSpent = (stats.slotsSpent || 0) + slotBet;
    updateBalances(true);
    writeSave(); // #fix5: сохраняем списание ДО анимации — закрытие вкладки не потеряет ставку

    // #fix2: контролируемый RTP слотов через WIN_THRESHOLD
    // Вместо честного random определяем сначала: будет ли выигрыш, затем какой символ
    const results = generateSlotResults();
    slotResult.innerHTML = UI_TEXT.resultSpin;

    let win = 0;
    try { // Fix-3: try/finally гарантирует разблокировку кнопки при любом исходе
      const targetIndices = await Promise.all(
        reelStrips.map((strip, i) => spinReel(strip, results[i], SLOT_CONFIG.REEL_DURATIONS[i], reelSymbolSequences[i]))
      );

      // GSN2-04 fix: Near-miss анимация — один из сильнейших retention-инструментов в слотах
      // При паре: shake на барабане с несовпавшим символом + текст "Почти!"
      const hasPair = results[0] === results[1] || results[1] === results[2] || results[0] === results[2];
      const hasTriple = results[0] === results[1] && results[1] === results[2];
      if (hasPair && !hasTriple) {
        // Найти несовпавший барабан
        let mismatchReel = null;
        if (results[0] === results[1] && results[1] !== results[2]) mismatchReel = reels[2];
        else if (results[1] === results[2] && results[0] !== results[1]) mismatchReel = reels[0];
        else if (results[0] === results[2] && results[0] !== results[1]) mismatchReel = reels[1];
        if (mismatchReel) {
          gsap.fromTo(mismatchReel, { x: 0 }, { x: 6, duration: 0.08, repeat: 5, yoyo: true, delay: 0.2 });
        }
      }

      let winType = '';

      if (results[0] === results[1] && results[1] === results[2]) {
        const mult = SLOT_CONFIG.PAYOUTS[results[0]] || SLOT_CONFIG.DEFAULT_PAYOUT_TRIPLE;
        win = Math.round(slotBet * mult);
        winType = SLOT_CONFIG.WIN_LABELS[results[0]] || SLOT_CONFIG.WIN_LABEL_DEFAULT;
        winLine.classList.remove('active');
        void winLine.offsetWidth;
        winLine.classList.add('active');
        gsap.fromTo(slotMachineEl, { scale: 1 }, { scale: 1.02, duration: 0.2, repeat: 3, yoyo: true });
      } else if (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]) {
        win = Math.floor(slotBet * SLOT_CONFIG.PAIR_PAYOUT); // GD2-06 fix: Math.floor вместо Math.round для детерминированного поведения
        winType = SLOT_CONFIG.WIN_LABEL_PAIR;
        winLine.classList.remove('active');
        void winLine.offsetWidth;
        winLine.classList.add('active');
      }

      // Fix-6: подсвечиваем выигрышный символ в центре каждого барабана
      if (win > 0) {
        reelStrips.forEach((strip, i) => {
          const sym = strip.children[targetIndices[i]];
          if (sym) sym.classList.add('win-symbol');
        });
      }

      if (win > 0) {
        playerBalance += win;
        siteBalance = Math.max(0, siteBalance - win);
        stats.totalWon += win;
        stats.slotsWon = (stats.slotsWon || 0) + win;
        slotResult.innerHTML = `🎉 ${winType}! ВЫИГРЫШ: ${win}₽`;
        const winRarity = win >= slotBet * 8 ? 'legendary' : win >= slotBet * 3 ? 'epic' : 'rare';
        playWinSound(winRarity);
        if (win > SLOT_CONFIG.CONFETTI_WIN_THRESHOLD) launchConfetti(40);
        if (win > SLOT_CONFIG.CONFETTI_BIG_THRESHOLD) launchConfetti(80);
        // GSN2-06 fix: увеличено с 1000мс до 2500мс — игрок успевает прочитать результат
        setTimeout(() => { winLine.classList.remove('active'); }, 2500);
      } else {
        // #fix9: убрана мёртвая ветка 'ПОЧТИ' — пара всегда win>0, else = всегда проигрыш
        slotResult.innerHTML = '😔 ПРОИГРЫШ';
        playLossSound();
        gsap.fromTo(slotMachineEl, { x: 0 }, { x: 5, duration: 0.1, repeat: 5, yoyo: true });
      }

      stats.totalSpins++;
      renderStats();
      addHistory({ icon: '🎰', name: 'Слоты', price: win, rarity: win > SLOT_CONFIG.CONFETTI_WIN_THRESHOLD ? 'epic' : 'common', source: 'slot' });
      updateBalances(true);

    } catch(err) {
      // Fix-3: при неожиданной ошибке возвращаем ставку
      console.error('Slot spin error:', err);
      playerBalance += slotBet;
      siteBalance = Math.max(0, siteBalance - slotBet);
      stats.totalSpent -= slotBet;
      stats.slotsSpent = Math.max(0, (stats.slotsSpent || 0) - slotBet);
      slotResult.innerHTML = '⚠️ Ошибка — ставка возвращена';
      updateBalances(true);
    } finally {
      stopSlotTicks();
      setButtonLoading(spinSlotBtn, false);
      isSlotSpinning = false; // Fix-4
      writeSave();
    }
  });

  // MODULE: components/games/CoinGame
  // ========== ОРЁЛ И РЕШКА ==========
  document.querySelectorAll('[data-coin-bet]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-coin-bet]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      coinBet = parseInt(btn.dataset.coinBet);
      coinCostLabel.textContent = coinBet;
    });
  });

  $('chooseEagle').addEventListener('click', () => {
    if (coinFlipping) return;
    document.querySelectorAll('.choice-btn').forEach(b => {
      b.classList.remove('active', 'result-win', 'result-loss');
      b.setAttribute('aria-pressed', 'false'); // Fix-12
    });
    $('chooseEagle').classList.add('active');
    $('chooseEagle').setAttribute('aria-pressed', 'true');
    playerChoice = 'eagle';
    coinResultEl.innerHTML = UI_TEXT.eagleChosen;
  });

  $('chooseTails').addEventListener('click', () => {
    if (coinFlipping) return;
    document.querySelectorAll('.choice-btn').forEach(b => {
      b.classList.remove('active', 'result-win', 'result-loss');
      b.setAttribute('aria-pressed', 'false');
    });
    $('chooseTails').classList.add('active');
    $('chooseTails').setAttribute('aria-pressed', 'true');
    playerChoice = 'tails';
    coinResultEl.innerHTML = UI_TEXT.tailsChosen;
  });

  flipCoinBtn.addEventListener('click', () => {
    if (coinFlipping) return;
    // QA-1 fix: блокируем монету пока идёт спин кейса (isSpinning)
    // чтобы предотвратить неожиданный параллельный расход баланса
    if (isSpinning) {
      showNotification('⏳ Дождись окончания спина кейса');
      return;
    }
    if (!playerChoice) {
      showNotification('⚠️ Сначала выбери орёл или решку!');
      return;
    }
    if (playerBalance < coinBet) {
      showNotification('❌ Недостаточно средств');
      flipCoinBtn.classList.add('btn-broke'); // #fix11
      setTimeout(() => flipCoinBtn.classList.remove('btn-broke'), 1500);
      return;
    }

    coinFlipping = true;
    setButtonLoading(flipCoinBtn, true);
    document.querySelectorAll('.choice-btn').forEach(b => b.style.pointerEvents = 'none');

    // BUG-05 fix: house edge встроен в вероятность (< 0.5 вместо ровно 0.5).
    // Списываем ставку полностью; при победе возвращаем x2. Никаких доп. edge-списаний.
    playerBalance -= coinBet;
    siteBalance += coinBet; // казино получает всю ставку
    stats.totalSpent += coinBet;
    stats.coinSpent = (stats.coinSpent || 0) + coinBet;
    updateBalances(true);

    // Честная монета с house edge через смещение вероятности
    const result = Math.random() < (0.5 - COIN_CONFIG.HOUSE_EDGE / 2) ? playerChoice : (playerChoice === 'eagle' ? 'tails' : 'eagle');
    const win = result === playerChoice;

    coinResultEl.innerHTML = UI_TEXT.coinFlying;

    // Анимация монеты
    coinEl.classList.remove('flipping');
    void coinEl.offsetWidth; // reflow
    coinEl.classList.add('flipping');

    // Звук — тики при броске
    playCoinFlip();

    setTimeout(() => {
      coinEl.classList.remove('flipping');
      // Фиксируем финальную сторону
      gsap.set(coinEl, { rotateY: result === 'tails' ? 180 : 0 });

      let winAmount = 0;
      // Fix: считаем победы игрока по его выбору, а не сторону монеты
      if (win) {
        if (playerChoice === 'eagle') stats.eagleWins = (stats.eagleWins || 0) + 1;
        else stats.tailsWins = (stats.tailsWins || 0) + 1;
      }

      // Fix-5: наглядный фидбек — правильная кнопка зеленеет, неверная краснеет
      const eagleBtn = $('chooseEagle');
      const tailsBtn = $('chooseTails');
      const chosenBtn  = playerChoice === 'eagle' ? eagleBtn : tailsBtn;
      const otherBtn   = playerChoice === 'eagle' ? tailsBtn : eagleBtn;
      chosenBtn.classList.remove('active');
      otherBtn.classList.remove('active');
      if (win) {
        chosenBtn.classList.add('result-win');
        otherBtn.classList.add('result-loss');
      } else {
        chosenBtn.classList.add('result-loss');
        otherBtn.classList.add('result-win');
      }
      // #fix18 UX: убираем цвет результата через 2.5с и сразу восстанавливаем выбор игрока
      // playerChoice сохраняется между бросками — не нужно выбирать заново каждый раз
      setTimeout(() => {
        chosenBtn.classList.remove('result-win', 'result-loss');
        otherBtn.classList.remove('result-win', 'result-loss');
        // Восстанавливаем подсветку текущего выбора игрока
        if (playerChoice === 'eagle') {
          $('chooseEagle').classList.add('active');
          $('chooseTails').classList.remove('active');
        } else if (playerChoice === 'tails') {
          $('chooseTails').classList.add('active');
          $('chooseEagle').classList.remove('active');
        }
      }, 2500);

      if (win) {
        winAmount = coinBet * COIN_CONFIG.WIN_MULTIPLIER;
        playerBalance += winAmount;
        siteBalance = Math.max(0, siteBalance - winAmount); // BUG-05 fix: без доп. edge
        stats.totalWon += winAmount;
        stats.coinWon = (stats.coinWon || 0) + winAmount;
        // BUG-02 fix: если шли поражения — сброс в 0, затем +1
        stats.coinStreak = (stats.coinStreak > 0 ? stats.coinStreak : 0) + 1;
        if (stats.coinStreak > stats.coinStreakBest) stats.coinStreakBest = stats.coinStreak;

        const label = result === 'eagle' ? '🦅 ОРЁЛ' : '₽ РЕШКА';
        coinResultEl.innerHTML = `${label}! 🎉 ВЫИГРЫШ: <b>${winAmount}₽</b>`;
        playWinSound('rare');
        launchConfetti(30);
        gsap.fromTo(coinMachineEl, { scale: 1 }, { scale: 1.015, duration: 0.18, repeat: 3, yoyo: true });
      } else {
        // BUG-02 fix: если шли победы — сброс в 0, затем -1
        stats.coinStreak = (stats.coinStreak < 0 ? stats.coinStreak : 0) - 1;
        const label = result === 'eagle' ? '🦅 ОРЁЛ' : '₽ РЕШКА';
        coinResultEl.innerHTML = `${label}... 😔 Проигрыш`;
        playLossSound();
        gsap.fromTo(coinMachineEl, { x: 0 }, { x: 6, duration: 0.08, repeat: 5, yoyo: true });
      }

      updateCoinStreak();
      stats.totalSpins++;
      renderStats();
      addHistory({
        icon: result === 'eagle' ? '🦅' : '₽',
        name: result === 'eagle' ? 'Орёл' : 'Решка',
        price: winAmount,
        rarity: win ? 'rare' : 'common',
        source: 'coin',
      });
      writeSave();
      updateBalances(true);

      coinFlipping = false;
      setButtonLoading(flipCoinBtn, false);
      document.querySelectorAll('.choice-btn').forEach(b => b.style.pointerEvents = 'auto');
      // #fix18: обновляем лейбл кнопки — показываем текущий выбор для следующего броска
      if (playerChoice) {
        const choiceLbl = playerChoice === 'eagle' ? '🦅 Орёл выбран' : '₽ Решка выбрана';
        setTimeout(() => { if (!coinFlipping) coinResultEl.textContent = choiceLbl + ' — ставь и бросай!'; }, 2600);
      }
    }, COIN_CONFIG.FLIP_DURATION);
  });

  function updateCoinStreak() {
    const s = stats.coinStreak;
    coinStreakVal.textContent = Math.abs(s);
    coinStreakIcon.textContent = s > 0 ? '🔥' : s < 0 ? '❄️' : '—';
    coinStreakVal.style.color = s > 0 ? '#4caf50' : s < 0 ? '#f44336' : 'var(--gold)';
  }

  // MODULE: hooks/useAudio
  // ========== АУДИО ==========
  function getAudio() {
    if (!audioCtx && soundEnabled) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    // GD2-04 / QA2-05 fix: Chrome/Safari создают AudioContext в suspended state,
    // первые звуки молчат если не вызвать resume() после user gesture
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Универсальный генератор одного тона
  function playTone(freq, type = 'sine', vol = 0.2, duration = 0.12, delay = 0) {
    if (!soundEnabled) return;
    try {
      const ctx = getAudio(); if (!ctx) return;
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.start(t); osc.stop(t + duration + 0.01);
    } catch(e) {}
  }

  // Выигрышная мелодия (кейс)
  function playWinSound(rarity) {
    if (!soundEnabled) return;
    const freqs = WIN_SOUNDS[rarity] || WIN_SOUNDS.common;
    freqs.forEach((freq, i) => playTone(freq, 'sine', 0.28, 0.45, i * 0.12));
  }

  // Звук проигрыша
  function playLossSound() {
    if (!soundEnabled) return;
    playTone(220, 'sawtooth', 0.15, 0.2, 0);
    playTone(180, 'sawtooth', 0.12, 0.3, 0.18);
  }

  // Тики при броске монеты
  function playCoinFlip() {
    if (!soundEnabled) return;
    for (let i = 0; i < COIN_CONFIG.TICK_COUNT; i++) {
      const progress = i / COIN_CONFIG.TICK_COUNT;
      const delay = progress * (COIN_CONFIG.FLIP_DURATION / 1000) * 0.85;
      // Частота нарастает и замедляется
      const freq = 600 + 400 * Math.sin(progress * Math.PI);
      playTone(freq, 'sine', 0.12, 0.07, delay);
    }
  }

  // GD-4 fix: тики синхронизированы с максимальной длительностью барабана (3.5 сек)
  // Интервал постепенно увеличивается — имитирует замедление вращения
  let _slotTickTimer = null;
  let _ticksRunning = false; // GD2-02 / QA2-03 fix: флаг для race condition
  function startSlotTicks() {
    if (!soundEnabled) return;
    _ticksRunning = true;
    const totalDuration = Math.max(...SLOT_CONFIG.REEL_DURATIONS) * 1000; // 3500мс
    const totalTicks = 38;
    let tickIdx = 0;
    function scheduleNext() {
      if (tickIdx >= totalTicks || !_ticksRunning) return; // проверяем флаг
      const progress = tickIdx / totalTicks;
      // Интервал от 50мс (быстро в начале) до 200мс (медленно в конце)
      const interval = 50 + Math.round(150 * progress * progress);
      _slotTickTimer = setTimeout(() => {
        if (!_ticksRunning) return; // повторная проверка внутри callback
        const freq = 350 - 80 * progress + Math.random() * 50;
        playTone(freq, 'triangle', 0.08 - 0.03 * progress, 0.06);
        tickIdx++;
        scheduleNext();
      }, interval);
    }
    scheduleNext();
  }
  function stopSlotTicks() {
    _ticksRunning = false; // GD2-02 fix: сначала флаг, потом clearTimeout
    clearTimeout(_slotTickTimer);
    _slotTickTimer = null;
  }

  // MODULE: hooks/useConfetti
  // ========== КОНФЕТТИ ==========
  /**
   * Запускает конфетти-эффект.
   * В React: хук useConfetti, DOM-манипуляции через ref на confetti-container
   * @param {number} amount количество элементов (макс. 200 суммарно)
   */
  function launchConfetti(amount = 60) {
    // BUG-16 fix: лимит на количество элементов в DOM
    const existing = confettiCont.children.length;
    if (existing >= 200) return;
    const toSpawn = Math.min(amount, 200 - existing);
    const colors = ['#ffd966','#ff6b6b','#6bcfff','#b8ff6b','#ff9ef0'];
    for (let i = 0; i < toSpawn; i++) {
      const el = document.createElement('div');
      el.className = 'confetto';
      el.style.cssText = [
        `left:${Math.random() * 100}%`,
        `background:${colors[Math.floor(Math.random() * colors.length)]}`,
        `width:${6 + Math.random() * 8}px`,
        `height:${6 + Math.random() * 8}px`,
        `border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
        `animation-duration:${1.5 + Math.random() * 2}s`,
        `animation-delay:${Math.random() * 0.5}s`,
      ].join(';');
      confettiCont.appendChild(el);
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }
  }

  function showLegendaryOverlay(item, onClose) {
    const overlay = document.createElement('div');
    overlay.className = 'legendary-overlay';
    // Fix: используем textContent для динамических данных — защита от XSS как в showConfirmModal
    overlay.innerHTML = `
      <div class="legendary-badge">✦ ЛЕГЕНДАРНЫЙ ДРОП ✦</div>
      <div class="legendary-icon-big"></div>
      <div class="legendary-name"></div>
      <div class="legendary-price"></div>
      <div class="legendary-tap">нажмите чтобы продолжить</div>
    `;
    overlay.querySelector('.legendary-icon-big').textContent = item.icon;
    overlay.querySelector('.legendary-name').textContent = item.name;
    overlay.querySelector('.legendary-price').textContent = `+${item.price}₽`;
    document.body.appendChild(overlay);
    launchConfetti(120);
    // GD2-01 / QA2-01 fix: guard против двойного вызова onClose()
    // (click + setTimeout оба вызывали close — stats.totalSpins++ дважды)
    let _overlayDone = false;
    const close = () => {
      if (_overlayDone) return;
      _overlayDone = true;
      overlay.classList.add('leaving');
      setTimeout(() => { overlay.remove(); onClose(); }, 500);
    };
    overlay.addEventListener('click', close, { once: true });
    setTimeout(close, 5000);
  }

  // MODULE: components/ui/helpers
  // ========== UI HELPERS ==========
  function setButtonLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // MODULE: components/ui/Notification
  // ========== УВЕДОМЛЕНИЯ ==========
  let _activeNotif = null;
  function showNotification(text, type = 'default') {
    // Убираем предыдущее если есть
    if (_activeNotif) {
      _activeNotif.classList.add('leaving');
      setTimeout(() => _activeNotif?.remove(), 250);
    }
    const notif = document.createElement('div');
    notif.className = 'notification';
    if (type === 'error') notif.style.borderColor = '#f44336';
    if (type === 'success') notif.style.borderColor = '#4caf50';
    notif.textContent = text;
    document.body.appendChild(notif);
    _activeNotif = notif;
    setTimeout(() => {
      if (_activeNotif === notif) {
        notif.classList.add('leaving');
        setTimeout(() => { notif.remove(); if (_activeNotif === notif) _activeNotif = null; }, 250);
      }
    }, 2800);
  }

  // MODULE: store/useGameStore (balance)
  // ========== БАЛАНС ==========
  let _prevPlayer = playerBalance;
  let _prevSite = siteBalance;

  // BUG-17 fix: храним RAF id на элемент чтобы отменять предыдущий цикл
  const _counterRAF = new WeakMap();

  function animateCounter(el, from, to, duration = 600) {
    // Отменяем предыдущую анимацию этого элемента
    if (_counterRAF.has(el)) cancelAnimationFrame(_counterRAF.get(el));
    const start = performance.now();
    const diff = to - from;
    if (diff === 0) { el.textContent = to; return; }
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + diff * ease);
      if (t < 1) {
        _counterRAF.set(el, requestAnimationFrame(step));
      } else {
        el.textContent = to;
        _counterRAF.delete(el);
      }
    }
    _counterRAF.set(el, requestAnimationFrame(step));
  }

  function spawnFloat(el, delta) {
    if (delta === 0) return;
    const rect = el.getBoundingClientRect();
    const div = document.createElement('div');
    div.className = 'balance-float ' + (delta > 0 ? 'positive' : 'negative');
    div.textContent = (delta > 0 ? '+' : '') + delta + '₽';
    div.style.left = (rect.left + rect.width / 2) + 'px';
    // DEV2-02 / QA2-04 fix: position:fixed использует viewport-координаты,
    // window.scrollY добавлять НЕ нужно — float уплывал вниз при прокрутке
    div.style.top = rect.top + 'px';
    document.body.appendChild(div);
    div.addEventListener('animationend', () => div.remove());
  }

  // CSN-1: порог авто-пополнения казино — если резерв опускается ниже, казино получает инвестиции
  const CASINO_REFILL_THRESHOLD = 1000;
  const CASINO_REFILL_AMOUNT    = 8000;

  let _refillScheduled = false; // #fix3: предотвращает несколько рефиллов за одну сессию событий
  function checkCasinoRefill() {
    if (_refillScheduled) return;
    if (siteBalance < CASINO_REFILL_THRESHOLD && !isSpinning && !isSlotSpinning && !coinFlipping) {
      _refillScheduled = true;
      const prev = siteBalance;
      siteBalance += CASINO_REFILL_AMOUNT;
      animateCounter(siteSpan, prev, siteBalance, 1200);
      _prevSite = siteBalance;
      showNotification(UI_TEXT.casinoRefill, 'success');
      renderOdds();
      renderPool();
      writeSave();
      setTimeout(() => { _refillScheduled = false; }, 5000); // сброс флага через 5с
    }
  }

  function updateBalances(animated = false) {
    if (animated) {
      const dPlayer = playerBalance - _prevPlayer;
      const dSite   = siteBalance   - _prevSite;
      if (dPlayer !== 0) spawnFloat(playerSpan, dPlayer);
      if (dSite   !== 0) spawnFloat(siteSpan,   dSite);
      animateCounter(playerSpan, _prevPlayer, playerBalance);
      animateCounter(siteSpan,   _prevSite,   siteBalance);
    } else {
      playerSpan.textContent = playerBalance;
      siteSpan.textContent   = siteBalance;
    }
    _prevPlayer = playerBalance;
    _prevSite   = siteBalance;

    if (!isSpinning) {
      const casinoBroke = siteBalance <= 0;
      spinBtn.disabled = casinoBroke;
      spinBtn.title = casinoBroke ? 'Казино банкрот — средств нет' : '';
      // CSN-1: триггерим рефилл после каждого обновления баланса
      if (siteBalance < CASINO_REFILL_THRESHOLD) {
        setTimeout(checkCasinoRefill, 800);
      }
    }
  }

  // MODULE: store/useGameStore (history)
  // ========== ИСТОРИЯ ==========
  function addHistory(item) {
    winHistory.unshift(item);
    if (winHistory.length > CONFIG.MAX_HISTORY) winHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    if (!winHistory.length) {
      historyList.innerHTML = `<span class="history-empty">${UI_TEXT.historyEmpty}</span>`;
      return;
    }
    const srcLabel = { case: 'КЕЙ', slot: 'СЛ', coin: 'МОН' };
    historyList.innerHTML = winHistory.map(it => {
      const isWin = it.price > 0;
      const cls = it.source === 'coin' ? (isWin ? 'win' : 'loss') : (isWin ? 'win' : 'neutral');
      const src = `<span class="src">${srcLabel[it.source] || '?'}</span>`;
      const priceStr = it.price > 0 ? `+${it.price}₽` : '—';
      // GSN-4: для кейса показываем имя предмета в title атрибуте и коротко в чипе
      // DEV2-04 fix: используем JSON.stringify для экранирования имени в атрибуте
      const nameAttr = it.name ? ` title="${it.name.replace(/"/g, '&quot;')}"` : '';
      return `<div class="history-chip ${cls}"${nameAttr}>${it.icon}${src} ${priceStr}</div>`;
    }).join('');
  }

  // MODULE: store/useGameStore (stats)
  // ========== СТАТИСТИКА ==========
  function rtpStr(spent, won) {
    if (!spent) return '—';
    const v = (won / spent * 100).toFixed(1);
    return v + '%';
  }
  function rtpColor(spent, won) {
    if (!spent) return 'var(--gold)';
    const v = won / spent * 100;
    return v >= 100 ? '#4caf50' : v >= 70 ? 'var(--gold)' : '#f44336';
  }

  function renderStats() {
    totalSpinsEl.textContent = stats.totalSpins;
    legendaryCountEl.textContent = stats.legendaryHits;
    totalSpentEl.textContent = stats.totalSpent + '₽';
    totalWonEl.textContent = stats.totalWon + '₽';
    $('statEagle').textContent = stats.eagleWins || 0;
    $('statTails').textContent = stats.tailsWins || 0;
    $('statStreakBest').textContent = stats.coinStreakBest || 0;
    const rS = stats.totalSpent, rW = stats.totalWon;
    rtpEl.textContent = rtpStr(rS, rW);
    rtpEl.style.color = rtpColor(rS, rW);
    // GSN-5: per-game RTP — видимые строки, не только тултип
    const cRtp = $('caseRtpEl'), sRtp = $('slotsRtpEl'), mRtp = $('coinRtpEl');
    cRtp.textContent = rtpStr(stats.caseSpent,  stats.caseWon);
    sRtp.textContent = rtpStr(stats.slotsSpent, stats.slotsWon);
    mRtp.textContent = rtpStr(stats.coinSpent,  stats.coinWon);
    cRtp.style.color = rtpColor(stats.caseSpent,  stats.caseWon);
    sRtp.style.color = rtpColor(stats.slotsSpent, stats.slotsWon);
    mRtp.style.color = rtpColor(stats.coinSpent,  stats.coinWon);
  }

  // MODULE: components/games/CaseGame (strip)
  // ========== ЛЕНТА КЕЙСА ==========
  /**
   * Fisher-Yates shuffle — используется в buildStrip и createSlotReels.
   * В React: вынести в utils/shuffle.js
   * @param {Array} arr
   * @returns {Array} перемешанный массив (новый)
   */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildStrip() {
    const countByRarity = ITEMS.reduce((acc, it) => {
      acc[it.rarity] = (acc[it.rarity] || 0) + 1;
      return acc;
    }, {});
    const itemWeights = ITEMS.map(item => ({
      item,
      w: CONFIG.RARITY_WEIGHT[item.rarity] / countByRarity[item.rarity],
    }));
    const totalW = itemWeights.reduce((s, p) => s + p.w, 0);

    const STRIP_LENGTH = CONFIG.STRIP_COPIES * CONFIG.ITEMS_PER_COPY;
    const result = [];
    for (let i = 0; i < STRIP_LENGTH; i++) {
      let r = Math.random() * totalW;
      let picked = itemWeights[itemWeights.length - 1].item;
      for (const { item, w } of itemWeights) {
        r -= w;
        if (r <= 0) { picked = item; break; }
      }
      result.push({ ...picked, uid: `${i}-${Math.random().toString(36).slice(2, 8)}` });
    }

    // QA-5 fix: гарантируем хотя бы 1 экземпляр каждого предмета в ленте.
    // Вероятность что Legendary (вес ~2%) не попадёт в 80 позиций ≈ 20%.
    // Заменяем случайную позицию на недостающий предмет.
    ITEMS.forEach(item => {
      if (!result.some(r => r.id === item.id)) {
        const idx = Math.floor(Math.random() * result.length);
        result[idx] = { ...item, uid: `guaranteed-${item.id}-${Math.random().toString(36).slice(2,8)}` };
      }
    });

    return shuffle(result);
  }

  function cardHTML(item) {
    return `<div class="item-card ${item.rarity}" data-uid="${item.uid}">
      <div class="item-icon">${item.icon}</div>
      <div class="item-name">${item.name}</div>
    </div>`;
  }

  function renderStrip() {
    itemsStrip.innerHTML = stripItems.map(cardHTML).join('');
    buildStripMap();
    // Fix-8: двойной rAF гарантирует завершение layout до чтения offsetWidth
    // (setTimeout(60) — магическое число, не гарантированное на медленных устройствах)
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const card = itemsStrip.querySelector('.item-card');
          if (card) itemWidth = card.offsetWidth + 10;
          centerStrip();
          resolve();
        });
      });
    });
  }

  function swapStrip() {
    const raw = gsap.getProperty(itemsStrip, 'x');
    const liveX = raw !== '' ? parseFloat(raw) : 0; // BUG-09 fix: не глотаем реальный 0
    stripItems = buildStrip();
    itemsStrip.innerHTML = stripItems.map(cardHTML).join('');
    buildStripMap();
    gsap.set(itemsStrip, { x: liveX });
    _lastFinalX = null; // Fix: старая позиция недействительна после перестройки ленты
  }

  function centerStrip() {
    if (!itemWidth) return;
    // Если есть зафиксированная позиция выигрыша — не трогаем ленту
    if (_lastFinalX !== null && !isSpinning) {
      gsap.set(itemsStrip, { x: _lastFinalX });
      return;
    }
    const cw = itemsStrip.parentElement.offsetWidth;
    const targetX = -(Math.floor(stripItems.length / 2) * itemWidth - (cw / 2 - itemWidth / 2));
    gsap.set(itemsStrip, { x: targetX });
  }

  // Map uid→item для O(1) поиска вместо O(n²)
  let stripMap = {};

  function buildStripMap() {
    stripMap = {};
    stripItems.forEach(it => { stripMap[it.uid] = it; });
  }

  function findCards(itemId) {
    return Array.from(itemsStrip.children).filter(card => {
      const it = stripMap[card.dataset.uid];
      return it && it.id === itemId;
    });
  }

  // MODULE: components/games/CaseGame (prize logic)
  // ========== РАСЧЕТ ПРИЗА ==========
  // Fix-8: getPrize теперь переиспользует computeWeights — нет дублирования countByRarity
  /**
   * Выбирает приз методом взвешенной случайности с учётом баланса казино.
   * В React: вынести в utils/caseWeights.js
   * @returns {Object} item из ITEMS
   */
  function getPrize() {
    const { pool, totalW } = computeWeights();

    // Фильтруем только доступные предметы; если ни одного — берём самый дешёвый
    let available = pool.filter(p => !p.isBlocked);
    if (!available.length) {
      const cheapest = ITEMS.reduce((min, it) => it.price < min.price ? it : min);
      return cheapest;
    }

    const total = available.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * total;
    for (const { item, w } of available) {
      r -= w;
      if (r <= 0) return item;
    }
    return available[available.length - 1].item;
  }

  // MODULE: components/games/CaseGame (weights)
  // ========== ОБЩИЙ РАСЧЁТ ВЕСОВ ==========
  /**
   * Вычисляет веса предметов с учётом баланса казино.
   * Дорогие предметы блокируются если казино не может выплатить.
   * В React: вынести в utils/caseWeights.js (чистая функция, зависит только от siteBalance)
   * @returns {{ pool, totalW, byRarity, totalRarity }}
   */
  function computeWeights() {
    const maxPayout = siteBalance * CONFIG.MAX_PAYOUT_RATIO;
    const countByRarity = ITEMS.reduce((acc, it) => {
      acc[it.rarity] = (acc[it.rarity] || 0) + 1;
      return acc;
    }, {});

    let pool = ITEMS.map(item => ({
      item,
      w: item.price <= maxPayout ? CONFIG.RARITY_WEIGHT[item.rarity] / countByRarity[item.rarity] : 0,
      isBlocked: item.price > maxPayout,
    }));

    // Fix-6: если все предметы заблокированы (казино почти банкрот) — отображаем
    // fallback-предмет с весом 100%, чтобы шансы в UI соответствовали getPrize()
    const allBlocked = pool.every(p => p.isBlocked);
    if (allBlocked) {
      const cheapest = ITEMS.reduce((min, it) => it.price < min.price ? it : min);
      pool = pool.map(p => ({
        ...p,
        w: p.item.id === cheapest.id ? 1 : 0,
        isBlocked: p.item.id !== cheapest.id,
      }));
    }

    const totalW = pool.reduce((s, p) => s + p.w, 0);

    const byRarity = {};
    pool.forEach(({ item, w }) => {
      if (!item.price || w === 0) return;
      byRarity[item.rarity] = (byRarity[item.rarity] || 0) + w;
    });
    const totalRarity = Object.values(byRarity).reduce((s, v) => s + v, 0);

    return { pool, totalW, byRarity, totalRarity };
  }

  // MODULE: components/games/CaseGame (pool render)
  // ========== ОТОБРАЖЕНИЕ ПУЛА ==========
  function renderPool() {
    const { pool, totalW } = computeWeights();
    const sorted = [...pool].sort((a, b) => b.item.price - a.item.price);
    const poolGrid = $('poolGrid');

    // #fix23: используем DOM API вместо innerHTML для item.name — защита от XSS
    poolGrid.innerHTML = '';
    sorted.forEach(({ item, w, isBlocked }) => {
      const pct = totalW > 0 ? (w / totalW * 100) : 0;
      const card = document.createElement('div');
      card.className = `pool-card ${item.rarity}${isBlocked ? ' blocked' : ''}`;
      const badge = document.createElement('div');
      badge.className = 'pool-card-badge';
      badge.textContent = RARITY_LABEL[item.rarity];
      card.appendChild(badge);
      if (isBlocked) {
        const lock = document.createElement('div');
        lock.className = 'pool-card-lock';
        lock.textContent = '🔒';
        card.appendChild(lock);
      }
      const icon = document.createElement('div');
      icon.className = 'pool-card-icon';
      icon.textContent = item.icon;
      const name = document.createElement('div');
      name.className = 'pool-card-name';
      name.textContent = item.name;
      const price = document.createElement('div');
      price.className = 'pool-card-price';
      price.textContent = item.price + '₽';
      const chance = document.createElement('div');
      chance.className = 'pool-card-chance';
      chance.textContent = pct.toFixed(1) + '%';
      card.append(icon, name, price, chance);
      poolGrid.appendChild(card);
    });
  }

  // MODULE: components/games/CaseGame (odds render)
  // ========== ОТОБРАЖЕНИЕ ШАНСОВ ==========
  function renderOdds() {
    const { byRarity, totalRarity } = computeWeights();

    oddsList.innerHTML = Object.keys(CONFIG.RARITY_WEIGHT).map(rarity => {
      const w = byRarity[rarity] || 0;
      const pct = totalRarity > 0 ? (w / totalRarity * 100) : 0;
      return `<div class="odds-row">
        <span class="odds-name">
          <span class="odds-dot" style="background:${RARITY_COLOR[rarity]}"></span>
          ${RARITY_LABEL[rarity]}
        </span>
        <span class="odds-pct">${pct.toFixed(1)}%</span>
      </div>`;
    }).join('');
  }

  /**
   * Основной игровой цикл кейса: списание ставки → анимация → выдача приза.
   * В React: хук useCaseSpin, GSAP-анимации через useRef
   */
  function spinRoulette() {
    if (isSpinning) return;
    if (!itemWidth) {
      // QA-2 fix: информируем игрока вместо тихого возврата
      showNotification('⚠️ Лента не загружена — попробуйте ещё раз');
      return;
    }
    if (playerBalance < CONFIG.SPIN_COST) {
      resultDiv.innerHTML = UI_TEXT.resultNoFunds;
      return;
    }
    _lastFinalX = null;

    // #fix6: clamp playerBalance — гонка двух вкладок не уведёт в минус
    if (playerBalance < CONFIG.SPIN_COST) {
      resultDiv.innerHTML = '😔 Недостаточно средств';
      return;
    }
    playerBalance -= CONFIG.SPIN_COST;
    siteBalance += CONFIG.SPIN_COST;
    stats.totalSpent += CONFIG.SPIN_COST;
    stats.caseSpent = (stats.caseSpent || 0) + CONFIG.SPIN_COST;
    playerBalance = Math.max(0, playerBalance); // clamp
    updateBalances(true);

    // Fix-1: приз выбирается ПОСЛЕ списания ставки — maxPayout считается по актуальному
    // siteBalance (который уже вырос на SPIN_COST), что соответствует реальному состоянию казино
    const prizeId = getPrize().id;

    isSpinning = true;
    setButtonLoading(spinBtn, true);
    resultDiv.innerHTML = UI_TEXT.resultSpin;

    // Убираем подсветку, НО не перестраиваем ленту прямо сейчас
    document.querySelectorAll('.item-card.win-highlight').forEach(c => {
      c.classList.remove('win-highlight');
    });

    if (currentAnim) currentAnim.kill();

    const stripW = itemWidth * stripItems.length;
    const cw = itemsStrip.parentElement.offsetWidth;
    const startX = parseFloat(gsap.getProperty(itemsStrip, 'x')) || 0;
    const spins = CONFIG.MIN_SPINS + Math.floor(Math.random() * CONFIG.EXTRA_SPINS);
    const dummyFinalX = startX - spins * stripW;

    let targetCard = null;
    let targetUid = null;
    let finalTargetX = null;

    const swapTimer = setTimeout(() => {
      const liveX = parseFloat(gsap.getProperty(itemsStrip, 'x'));

      // Перестраиваем ленту только во время движения (не в момент показа результата)
      swapStrip();

      const cards = findCards(prizeId);
      if (!cards.length) {
        // Нет карточки с нужным id — аварийный выход без потери ставки
        playerBalance += CONFIG.SPIN_COST; // возврат
        siteBalance = Math.max(0, siteBalance - CONFIG.SPIN_COST);
        stats.totalSpent -= CONFIG.SPIN_COST;
        stats.caseSpent = Math.max(0, (stats.caseSpent || 0) - CONFIG.SPIN_COST); // Bug-fix: синхронизируем caseSpent
        updateBalances(true);
        resultDiv.innerHTML = '⚠️ Ошибка раздачи — ставка возвращена';
        isSpinning = false;
        setButtonLoading(spinBtn, false);
        currentAnim = null;
        return;
      }
      targetCard = cards[Math.floor(Math.random() * cards.length)];
      targetUid = targetCard.dataset.uid;
      const tIdx = Array.from(itemsStrip.children).indexOf(targetCard);
      finalTargetX = -(tIdx * itemWidth - (cw / 2 - itemWidth / 2));

      let newFinalX = finalTargetX;
      while (newFinalX > liveX - stripW * 3) newFinalX -= stripW;

      if (currentAnim) currentAnim.kill();
      const remaining = CONFIG.SPIN_DURATION - CONFIG.SWAP_DELAY / 1000;

      currentAnim = gsap.fromTo(itemsStrip,
        { x: liveX },
        {
          x: newFinalX,
          duration: remaining,
          ease: CONFIG.SPIN_EASE_END,
          modifiers: {
            x: gsap.utils.unitize(x => {
              const v = parseFloat(x);
              return ((v % stripW) - stripW) % stripW;
            }),
          },
          onComplete: onSpinDone,
        }
      );
    }, CONFIG.SWAP_DELAY);

    function onSpinDone() {
      clearTimeout(swapTimer);

      if (finalTargetX !== null) gsap.set(itemsStrip, { x: finalTargetX });
      if (targetCard) targetCard.classList.add('win-highlight');

      const winItem = stripItems.find(s => s.uid === targetUid);
      if (winItem) {
        const { rarity, icon, name, price } = winItem;
        const isLegendary = rarity === 'legendary';

        resultDiv.innerHTML = `🎉 ВЫИГРЫШ: <span>${icon} ${name} — ${price}₽</span>`;

        playerBalance += price;
        siteBalance = Math.max(0, siteBalance - price);
        stats.totalWon += price;
        stats.caseWon = (stats.caseWon || 0) + price;
        if (isLegendary) stats.legendaryHits++;
        updateBalances(true);

        addHistory({ ...winItem, source: 'case' });
        renderOdds();
        renderPool();
        playWinSound(rarity);
        if (isLegendary) {
          // GSN-2: wow-момент — fullscreen оверлей, затем обычный финиш
          showLegendaryOverlay(winItem, () => {
            stats.totalSpins++;
            renderStats();
            writeSave();
            isSpinning = false;
            setButtonLoading(spinBtn, false);
            currentAnim = null;
            // GD2-08 fix: убираем второй updateBalances() — баланс уже обновлён
            // до showLegendaryOverlay, повторный вызов перезаписывал числа без анимации
            _lastFinalX = finalTargetX;
          });
          return; // финиш будет вызван из оверлея
        }
        else if (rarity === 'epic') launchConfetti(35);
      }

      stats.totalSpins++;
      renderStats();
      writeSave();
      isSpinning = false;
      setButtonLoading(spinBtn, false);
      currentAnim = null;
      // GD-1 fix: updateBalances() ПОСЛЕ isSpinning=false — теперь casinoBroke проверяется
      // корректно и кнопка дизейблится если казино банкрот после выплаты
      updateBalances();
      _lastFinalX = finalTargetX;
    }

    currentAnim = gsap.to(itemsStrip, {
      x: dummyFinalX,
      duration: CONFIG.SPIN_DURATION,
      ease: CONFIG.SPIN_EASE_START,
      modifiers: {
        x: gsap.utils.unitize(x => {
          const v = parseFloat(x);
          return ((v % stripW) - stripW) % stripW;
        }),
      },
      onComplete: () => {
        try {
          onSpinDone();
        } catch(err) {
          // DEV2-01 fix: если onSpinDone упала — сбрасываем состояние чтобы не залипнуть
          console.error('spinRoulette onComplete error:', err);
          playerBalance += CONFIG.SPIN_COST;
          siteBalance = Math.max(0, siteBalance - CONFIG.SPIN_COST);
          stats.totalSpent -= CONFIG.SPIN_COST;
          stats.caseSpent = Math.max(0, (stats.caseSpent || 0) - CONFIG.SPIN_COST);
          updateBalances(true);
          resultDiv.innerHTML = '⚠️ Ошибка — ставка возвращена';
          isSpinning = false;
          setButtonLoading(spinBtn, false);
          currentAnim = null;
        }
      },
    });
  }

  // ========== ОБРАБОТЧИКИ ==========
  spinBtn.addEventListener('click', () => spinRoulette());

  let _lastTopup = 0;
  topupBtn.addEventListener('click', () => {
    const now = Date.now();
    if (now - _lastTopup < 500) return; // антиспам 500мс
    _lastTopup = now;
    // #fix1: лимит пополнений в сутки
    const today = new Date().toDateString();
    if (topupDate !== today) { topupDate = today; topupToday = 0; }
    if (topupToday >= CONFIG.TOPUP_DAILY_LIMIT) {
      showNotification(UI_TEXT.topupLimit(CONFIG.TOPUP_DAILY_LIMIT), 'error');
      return;
    }
    topupToday++;
    playerBalance += CONFIG.TOPUP_AMOUNT;
    updateBalances(true);
    updateTopupBtn();
    writeSave();
  });

  function updateTopupBtn() {
    const today = new Date().toDateString();
    if (topupDate !== today) topupToday = 0;
    const remaining = CONFIG.TOPUP_DAILY_LIMIT - topupToday;
    topupBtn.disabled = remaining <= 0;
    topupBtn.title = remaining > 0 ? `Осталось пополнений сегодня: ${remaining}` : 'Лимит пополнений исчерпан';
    const lbl = $('topupLabel');
    if (lbl) lbl.textContent = CONFIG.TOPUP_AMOUNT;
  }

  soundToggle.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundToggle.textContent = soundEnabled ? '🔊' : '🔇';
    if (!soundEnabled && audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    writeSave();
  });

  // ========== КАСТОМНЫЙ CONFIRM ==========
  // DEV-5 fix: CSS-классы вместо inline styles — единая точка стилизации
  function showConfirmModal(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    // DEV2-03 fix: используем textContent вместо innerHTML для confirm-message
    // чтобы исключить XSS если message когда-либо придёт из внешнего источника
    const box = document.createElement('div');
    box.className = 'confirm-box';
    box.innerHTML = `
      <div class="confirm-icon">⚠️</div>
      <div class="confirm-message"></div>
      <div class="confirm-btns">
        <button class="_confirmYes confirm-yes">ДА</button>
        <button class="_confirmNo  confirm-no">ОТМЕНА</button>
      </div>
    `;
    box.querySelector('.confirm-message').textContent = message;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.querySelector('._confirmYes').addEventListener('click', () => { overlay.remove(); onConfirm(); });
    overlay.querySelector('._confirmNo').addEventListener('click',  () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  resetBtn.addEventListener('click', () => {
    showConfirmModal('Сбросить весь прогресс?', () => {
      // QA-3 fix: убиваем все активные анимации и сбрасываем флаги вращения
      // чтобы кнопки не оставались залоченными после Reset во время анимации
      if (currentAnim) { currentAnim.kill(); currentAnim = null; }
      isSpinning    = false;
      isSlotSpinning = false;
      coinFlipping  = false;
      setButtonLoading(spinBtn,     false);
      setButtonLoading(spinSlotBtn, false);
      setButtonLoading(flipCoinBtn, false);
      stopSlotTicks();

      playerBalance = CONFIG.START_BALANCE;
      siteBalance = CONFIG.SITE_BALANCE;
      // Fix-5: включаем все per-game поля, чтобы RTP-тултип сбрасывался сразу
      stats = {
        totalSpins: 0, legendaryHits: 0, totalSpent: 0, totalWon: 0,
        coinStreak: 0, coinStreakBest: 0, eagleWins: 0, tailsWins: 0,
        caseSpent: 0, caseWon: 0, slotsSpent: 0, slotsWon: 0, coinSpent: 0, coinWon: 0,
      };
      winHistory = [];
      playerChoice = null;
      // Fix-4: сбрасываем slotBet наравне с coinBet
      slotBet = 25;
      coinBet = 25;
      topupToday = 0; // #fix1: сбрасываем счётчик топапов
      topupDate  = null;
      lastVisit  = null; // #fix4: сбрасываем дату визита вместе с прогрессом
      _lastFinalX = null;
      document.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('active'));
      // Fix-4: переключаем кнопки ставок слотов на дефолт
      document.querySelectorAll('[data-slot-bet]').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.slotBet) === slotBet)
      );
      document.querySelectorAll('[data-coin-bet]').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.coinBet) === coinBet)
      );
      // Fix-11: явно обновляем оба лейбла ставок
      slotCostLabel.textContent = slotBet;
      coinCostLabel.textContent = coinBet;
      gsap.set(coinEl, { rotateY: 0 });
      coinResultEl.innerHTML = UI_TEXT.coinIdle;
      updateTopupBtn();
      updateCoinStreak();
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
      updateBalances();
      renderStats();
      renderHistory();
      stripItems = buildStrip();
      renderStrip().then(() => {
        renderOdds();
        renderPool();
      });
    });
  });

  // Дебаунс на resize
  let _resizeTimer = null;
  let _lastSymbolHeight = getSymbolHeight();
  // DEV-6 fix: orientationchange как отдельный триггер — на ряде мобильных устройств
  // resize не стреляет при повороте экрана, поэтому слушаем оба события
  function handleResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (!isSpinning) {
        const card = itemsStrip.querySelector('.item-card');
        if (card) {
          itemWidth = card.offsetWidth + 10;
          const winCard = itemsStrip.querySelector('.win-highlight');
          if (winCard) {
            const cw = itemsStrip.parentElement.offsetWidth;
            const tIdx = Array.from(itemsStrip.children).indexOf(winCard);
            _lastFinalX = -(tIdx * itemWidth - (cw / 2 - itemWidth / 2));
          }
          centerStrip();
        }
        const newH = getSymbolHeight();
        if (newH !== _lastSymbolHeight) {
          _lastSymbolHeight = newH;
          // QA2-06 fix: не пересоздаём барабаны во время слот-анимации
          // (GSAP теряет целевой элемент если reelStrips пересоздаются во время spinReel)
          if (!isSlotSpinning) {
            createSlotReels();
          }
        }
      }
    }, 150);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', () => {
    // После поворота дожидаемся завершения перерисовки браузером (200мс)
    setTimeout(handleResize, 200);
  });

  // Ежедневный бонус: сравниваем lastVisit (state) с сегодня
  // lastVisit=null → первый запуск → бонус не выдаём, просто запоминаем дату
  // lastVisit='вчера' → новый день → выдаём бонус
  function checkDailyBonus() {
    const today = new Date().toDateString();
    if (lastVisit === today) return; // уже были сегодня
    const isReturn = lastVisit !== null; // не первый запуск
    lastVisit = today;
    if (isReturn) {
      const bonus = CONFIG.DAILY_BONUS;
      playerBalance += bonus;
      updateBalances(true);
      showNotification(UI_TEXT.dailyBonus(bonus), 'success');
    }
    writeSave();
  }

  function init() {
    checkDailyBonus();
    topupLabel.textContent = CONFIG.TOPUP_AMOUNT;
    spinCostLabel.textContent = CONFIG.SPIN_COST;
    slotCostLabel.textContent = slotBet;
    coinCostLabel.textContent = coinBet;
    soundToggle.textContent = soundEnabled ? '🔊' : '🔇';
    updateTopupBtn();
    _prevPlayer = playerBalance;
    _prevSite   = siteBalance;
    updateCoinStreak();

    // BUG-15 fix: восстанавливаем активные кнопки ставок из сохранения
    document.querySelectorAll('[data-slot-bet]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.slotBet) === slotBet);
    });
    document.querySelectorAll('[data-coin-bet]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.coinBet) === coinBet);
    });

    switchTab('case', true);

    stripItems = buildStrip();
    spinBtn.disabled = true;

    renderStrip().then(() => {
      spinBtn.disabled = false;
      updateBalances();
      renderOdds();
      renderPool();
      renderStats();
      renderHistory();
    });
  }

  // QA2-07 fix: синхронизация между двумя открытыми вкладками
  // (раньше last-write-wins вызывал непредсказуемые балансы)
  window.addEventListener('storage', e => {
    if (e.key === STORAGE_KEY && !isSpinning && !isSlotSpinning && !coinFlipping) {
      const fresh = loadSave();
      if (fresh) {
        playerBalance = fresh.playerBalance;
        siteBalance   = fresh.siteBalance;
        stats         = fresh.stats;
        winHistory    = fresh.winHistory;
        _prevPlayer   = playerBalance;
        _prevSite     = siteBalance;
        updateBalances();
        renderStats();
        renderHistory();
      }
    }
  });

  // QA-4 fix: очищаем конфетти при уходе вкладки в фон — animationend не стреляет
  // в фоновых вкладках, поэтому DOM-элементы накапливались до лимита 200
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) confettiCont.innerHTML = '';
  });

  init();
})();