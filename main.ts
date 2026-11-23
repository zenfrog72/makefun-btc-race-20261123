// Trend rider for the cbBTC 24h bars race (agent-fun/bars-replay/v1).
//
// Idea in one paragraph: on a thin on-chain pool a full round trip costs
// roughly 26-35 bps in fees, slippage and price impact, so this bot only
// trades when a move is already under way and big enough to pay for the
// trip. It follows the trend of the minute bars with two EMAs, asks a
// 30-bar momentum check to confirm the move, rides the position while the
// trend holds, and gets out on a trend break, a trailing stop or a hard
// stop. Risk is capped three ways: one position at a time, a cooldown
// after every exit so a choppy patch cannot machine-gun the fees, and an
// equity drawdown halt that parks the bot in cash for the rest of the
// window once it has given back too much from its peak.
//
// Everything is decided from the bars in each batch and the account the
// harness reports: no clock, no randomness, no environment, so two runs
// over the same hello and the same batches send the same orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** EMA spans, in bars: a quarter hour against an hour. */
const FAST_SPAN = 15;
const SLOW_SPAN = 60;
/** Momentum is the return over this many bars, in bps. */
const MOM_BARS = 30;
const MOM_MIN_BPS = 10;
/** The fast EMA must lead the slow one by at least this much, in bps. */
const SPREAD_MIN_BPS = 3;
/** Leave a position once the close falls this far under its best close. */
const TRAIL_BPS = 110;
/** Hard stop: this far under the price the position actually filled at. */
const STOP_BPS = 140;
/** Bars to sit out after an exit before any new entry. */
const COOLDOWN_BARS = 15;
/** A fresh entry signal stays usable for this many bars. */
const ENTRY_WINDOW_BARS = 6;
/** Equity drawdown from its peak that halts trading for the window. */
const HALT_DRAWDOWN = 0.08;
/** Share of the cash a buy spends (the fee comes out of the notional). */
const SPEND_NUM = 98n;
const SPEND_DEN = 100n;
/** Slippage caps: entries refuse a gap up, exits allow a wider one. */
const BUY_SLIPPAGE_BPS = 60;
const SELL_SLIPPAGE_BPS = 100;
/** No fresh entries this close to the end of a 1,440-bar window. */
const LAST_ENTRY_SEQ = 1400;

/** One EMA: the closes it collects until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

// The traded symbol is the universe's only symbol; its name arrives in
// the hello, so nothing here hardcodes a ticker.
let symbol = '';
const fast = makeEma(FAST_SPAN);
const slow = makeEma(SLOW_SPAN);
/** Recent closes, oldest first, enough for the momentum lookback. */
const closes: number[] = [];
/** Whether the entry signal (trend up, spread and momentum met) held after the previous bar. */
let signalWas = false;
/** Seq of the batch where the current fresh signal began. */
let signalSeq = -1;
/** Seq of the last buy and sell orders sent; a fill reports one batch later, so one order at a time. */
let lastBuySeq = -10;
let lastSellSeq = -10;
/** Seq of the batch on which the last position was seen closed. */
let lastExitSeq = -1000;
/** Whether a position was held after the previous batch. */
let wasHolding = false;
/** Fill price of the open position (raw price units) and its best close since. */
let entryPrice = 0;
let peakClose = 0;
/** Highest equity seen, and the halt it arms. */
let peakEquity = 0n;
let halted = false;

/** The entry signal on the latest close: trend up with room and momentum. */
function signalNow(close: number): boolean {
  if (fast.value === null || slow.value === null) return false;
  if (closes.length <= MOM_BARS) return false;
  const back = closes[closes.length - 1 - MOM_BARS]!;
  const momentumBps = ((close - back) / back) * 10_000;
  const spreadBps = ((fast.value - slow.value) / slow.value) * 10_000;
  return fast.value > slow.value && spreadBps >= SPREAD_MIN_BPS && momentumBps >= MOM_MIN_BPS;
}

/** Whether the open position should be sold on this close. */
function exitNow(close: number): boolean {
  if (halted) return true;
  if (fast.value !== null && slow.value !== null && fast.value < slow.value) return true;
  if (peakClose > 0 && close <= peakClose * (1 - TRAIL_BPS / 10_000)) return true;
  if (entryPrice > 0 && close <= entryPrice * (1 - STOP_BPS / 10_000)) return true;
  return false;
}

await runBars({
  onHello(state: BarsState) {
    symbol = state.hello.symbols[0]!.symbol;
    peakEquity = state.equity;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fills of the orders sent on the previous batch arrive with this
    // one: a filled buy fixes the price the stops measure from, and a
    // filled sell is what starts the cooldown.
    for (const fill of batch.fills) {
      if (fill.symbol !== symbol) continue;
      if (fill.status === 'filled' && fill.side === 'buy') {
        entryPrice = Number(fill.price);
        peakClose = entryPrice;
      }
    }

    let close: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== symbol) continue;
      close = Number(bar.c);
      closes.push(close);
      if (closes.length > MOM_BARS + 1) closes.shift();
      stepEma(fast, close);
      stepEma(slow, close);
    }

    if (state.equity > peakEquity) peakEquity = state.equity;
    if (peakEquity > 0n && state.equity * 100n <= peakEquity * BigInt(Math.round((1 - HALT_DRAWDOWN) * 100))) {
      halted = true;
    }

    const held = state.positions.get(symbol);
    const holding = held !== undefined && held.qty > 0n;
    if (wasHolding && !holding) lastExitSeq = batch.seq;
    wasHolding = holding;

    if (state.warmingUp || close === null) return [];
    if (holding && close > peakClose) peakClose = close;

    const signal = signalNow(close);
    if (signal && !signalWas) signalSeq = batch.seq;
    signalWas = signal;

    // Exit first: a held position that trips any stop leaves before any
    // new entry is considered, and its sell is retried while the reason
    // holds (a refused sell comes back as still holding two bars on).
    if (holding && exitNow(close)) {
      if (batch.seq - lastSellSeq >= 2) {
        lastSellSeq = batch.seq;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (holding || halted) return [];

    // Entry: a fresh signal, inside its window, past the cooldown, with
    // no buy still in flight and enough of the window left to matter.
    const fresh = signal && batch.seq - signalSeq <= ENTRY_WINDOW_BARS;
    const cooled = batch.seq - lastExitSeq >= COOLDOWN_BARS;
    const inFlight = batch.seq - lastBuySeq < 2;
    if (!fresh || !cooled || inFlight || batch.seq > LAST_ENTRY_SEQ) return [];
    const spend = (state.cash * SPEND_NUM) / SPEND_DEN;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    lastBuySeq = batch.seq;
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: BUY_SLIPPAGE_BPS }];
  },
});
