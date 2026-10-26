import {HmIPClientError} from './errors.js';
import type {HmIPState, HmIPStateChange} from './state.js';
import {freezeHmIPState, reduceHmIPState} from './state-store.js';
import type {HmIPConnectionListener} from './websocket-client.js';

export interface HmIPSessionTransport {
  init(signal?: AbortSignal): Promise<void>;
  getCurrentState(signal?: AbortSignal): Promise<HmIPState>;
  connect(listener: (change: HmIPStateChange) => void, connection?: HmIPConnectionListener): void;
  disconnect(): void;
}
export type HmIPSessionStatus = 'connecting' | 'synchronizing' | 'ready' | 'disconnected' | 'stopped';
export interface HmIPSessionObserver {
  snapshot(state: HmIPState): void | Promise<void>;
  change(change: HmIPStateChange, state: HmIPState): void | Promise<void>;
  status(status: HmIPSessionStatus): void | Promise<void>;
  error(error: HmIPClientError): void;
}
export interface HmIPSessionOptions {
  retryMillis?: number;
  maxBufferedEvents?: number;
}

function transientEvents(change: HmIPStateChange): HmIPStateChange {
  return {events: Object.fromEntries(Object.entries(change.events).filter(([, event]) =>
    event.pushEventType === 'DEVICE_CHANNEL_EVENT'
    || event.pushEventType === 'SECURITY_JOURNAL_CHANGED'
    || event.pushEventType === 'UNKNOWN'))};
}

/** Owns one transport connection. Snapshots and changes are deeply frozen at runtime. */
export class HmIPSession {
  private generation = new AbortController();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private pending: HmIPStateChange[] | undefined;
  private pendingCount = 0;
  private undelivered: HmIPStateChange[] = [];
  private state: HmIPState | undefined;
  private connected = false;
  private started = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();
  private currentStatus: HmIPSessionStatus = 'connecting';
  constructor(private readonly client: HmIPSessionTransport, private readonly observer: HmIPSessionObserver,
    private readonly options: HmIPSessionOptions = {}) {}

  get status(): HmIPSessionStatus { return this.currentStatus; }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.initialize();
    await this.whenIdle();
  }

  /** Wait for already scheduled work, useful for graceful shutdown and deterministic consumers. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const work = this.work;
      const queue = this.queue;
      await work;
      await queue;
      if (work === this.work && queue === this.queue) return;
    }
  }

  private notify(task: () => void | Promise<void>, signal = this.generation.signal): void {
    this.queue = this.queue.then(async () => {
      if (!signal.aborted && !this.stopped) await task();
    }).catch(async () => {
      // Consumer exceptions must not become unhandled rejections or leak payloads.
      if (this.stopped || signal.aborted) return;
      this.cancel();
      this.currentStatus = 'synchronizing';
      this.report(new HmIPClientError('invalid-response', 'session/observer'));
      try { await this.observer.status('synchronizing'); } catch { /* Already reported the observer failure. */ }
      this.retryWith(() => this.synchronize());
    });
  }
  private report(error: HmIPClientError): void {
    try { this.observer.error(error); } catch { /* Isolate observer failures. */ }
  }
  private setStatus(status: HmIPSessionStatus): void {
    if (status !== 'ready') this.currentStatus = status;
    this.notify(async () => {
      this.currentStatus = status;
      await this.observer.status(status);
    });
  }
  private cancel(): void {
    this.generation.abort();
    this.generation = new AbortController();
    clearTimeout(this.retry);
    this.retry = undefined;
    this.pending = undefined;
    this.pendingCount = 0;
    this.undelivered = [];
  }
  private retryWith(task: () => Promise<void>): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.work = task();
    }, this.options.retryMillis ?? 5000);
    this.retry.unref();
  }
  private async initialize(): Promise<void> {
    const signal = this.generation.signal;
    this.setStatus('connecting');
    try {
      await this.client.init(signal);
      if (signal.aborted || this.stopped) return;
      // Establish listeners before fetching state, so events during the snapshot cannot be lost.
      this.client.connect(change => this.receive(change), event => {
        if (this.stopped) return;
        this.cancel();
        this.connected = event !== 'disconnected';
        if (!this.connected) this.setStatus('disconnected');
        else this.work = this.synchronize();
      });
      // Bootstrap discovery even while the websocket handshake is pending. Never mark it ready yet.
      if (!this.connected) this.work = this.synchronize();
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      this.setStatus('disconnected');
      this.report(error instanceof HmIPClientError ? error : new HmIPClientError('network', 'session/init'));
      this.retryWith(() => this.initialize());
    }
  }
  private async synchronize(): Promise<void> {
    const signal = this.generation.signal;
    this.pending = [];
    this.pendingCount = 0;
    this.setStatus('synchronizing');
    try {
      let state = await this.client.getCurrentState(signal);
      if (signal.aborted || this.stopped) return;
      const buffered = [...this.undelivered, ...(this.pending ?? [])];
      this.undelivered = [];
      for (const change of buffered) state = reduceHmIPState(state, change);
      this.state = freezeHmIPState(state);
      this.pending = undefined;
      this.notify(() => this.observer.snapshot(state), signal);
      this.setStatus(this.connected ? 'ready' : 'disconnected');
      // Transient channel events are delivered once, after the merged snapshot.
      for (const change of buffered) {
        const {events} = transientEvents(change);
        if (Object.keys(events).length) this.deliver({events});
      }
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      const buffered = this.pending ?? [];
      this.pending = undefined;
      this.setStatus(this.connected ? 'synchronizing' : 'disconnected');
      this.report(error instanceof HmIPClientError ? error : new HmIPClientError('network', 'home/getCurrentState'));
      // Preserve presses if there is a previous state, but never claim the cache is synchronized.
      for (const change of buffered) {
        const {events} = transientEvents(change);
        if (Object.keys(events).length) {
          if (this.state) this.deliver({events});
          else this.undelivered.push({events});
        }
      }
      this.retryWith(() => this.synchronize());
    }
  }
  private receive(change: HmIPStateChange): void {
    if (this.stopped || !this.connected) return;
    if (this.pending) {
      this.pendingCount += Object.keys(change.events).length;
      if (this.pendingCount + this.undelivered.reduce((n, c) => n + Object.keys(c.events).length, 0) > (this.options.maxBufferedEvents ?? 10000)) {
        this.cancel();
        this.setStatus('synchronizing');
        this.report(new HmIPClientError('event-buffer-full', 'session/events'));
        this.retryWith(() => this.synchronize());
        return;
      }
      this.pending.push(change);
    } else if (this.state) this.deliver(change);
    else {
      const {events} = transientEvents(change);
      if (Object.keys(events).length) this.undelivered.push({events});
      if (this.undelivered.reduce((n, c) => n + Object.keys(c.events).length, 0) > (this.options.maxBufferedEvents ?? 10000)) {
        this.undelivered = [];
        this.report(new HmIPClientError('event-buffer-full', 'session/events'));
      }
    }
  }
  private deliver(change: HmIPStateChange): void {
    if (!this.state) return;
    const state = freezeHmIPState(reduceHmIPState(this.state, change));
    this.state = state;
    const frozen = freezeHmIPState(change);
    this.notify(() => this.observer.change(frozen, state));
  }
  async stop(): Promise<void> {
    if (this.stopped) return this.queue;
    this.stopped = true;
    this.cancel();
    this.currentStatus = 'stopped';
    this.client.disconnect();
    await this.queue;
    await this.observer.status('stopped');
  }
}
