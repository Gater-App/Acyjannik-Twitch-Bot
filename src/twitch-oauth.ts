import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Logger } from './logger.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scopes?: string[];
}

export interface OAuthFlow { name:string; oauth:TwitchOAuth; startPath?:string; callbackPath:string; }

interface TwitchTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string[];
  token_type: string;
}

export class FileTokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredTokens | undefined> {
    try {
      const mode = fsSync.statSync(this.filePath).mode & 0o777;
      if ((mode & 0o077) !== 0) await fs.chmod(this.filePath, 0o600);
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredTokens>;
      if (!parsed.accessToken || !parsed.refreshToken) return undefined;
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        ...(Array.isArray(parsed.scopes)?{scopes:parsed.scopes.filter((scope):scope is string=>typeof scope==='string')}: {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}

export class TwitchOAuth {
  private tokens?: StoredTokens;
  private readonly authorizationWaiters: Array<() => void> = [];

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly scopes: string[],
    private readonly store: FileTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly logger: Logger = consoleLogger,
  ) {}

  async initialize(accessToken?: string, refreshToken?: string): Promise<void> {
    const stored = await this.store.load();
    const resolvedRefreshToken = refreshToken || stored?.refreshToken;
    const resolvedAccessToken = accessToken || stored?.accessToken;
    if (resolvedAccessToken && resolvedRefreshToken) {
      this.tokens = { accessToken: resolvedAccessToken, refreshToken: resolvedRefreshToken, ...(stored?.expiresAt ? { expiresAt: stored.expiresAt } : {}),
        ...(stored?.scopes ? {scopes:stored.scopes}: {}) };
    } else if (resolvedRefreshToken) {
      await this.refresh(resolvedRefreshToken);
    }
  }

  get hasAccessToken(): boolean { return Boolean(this.tokens?.accessToken); }
  get grantedScopes(): string[] { return this.tokens?.scopes || []; }

  waitForAuthorization(): Promise<void> {
    if (this.hasAccessToken) return Promise.resolve();
    return new Promise<void>((resolve) => this.authorizationWaiters.push(resolve));
  }

  get authorizationUrl(): string {
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.scopes.join(' '));
    return url.toString();
  }

  async exchangeCode(code: string): Promise<void> {
    const response = await this.fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
      }),
    });
    const payload = await parseJsonResponse<TwitchTokenResponse>(response);
    await this.savePayload(payload);
    this.resolveAuthorizationWaiters();
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error('Noch kein Twitch-OAuth-Token vorhanden. Öffne die lokale OAuth-URL.');
    return this.tokens.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.tokens?.refreshToken) throw new Error('Kein Twitch-Refresh-Token vorhanden.');
    await this.refresh(this.tokens.refreshToken);
    return this.tokens.accessToken;
  }

  private async refresh(refreshToken: string): Promise<void> {
    const response = await this.fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const payload = await parseJsonResponse<TwitchTokenResponse>(response);
    await this.savePayload(payload, refreshToken);
    this.logger.info('Twitch-OAuth-Token erneuert.');
  }

  private async savePayload(payload: TwitchTokenResponse, fallbackRefreshToken?: string): Promise<void> {
    const refreshToken = payload.refresh_token || fallbackRefreshToken;
    if (!refreshToken) throw new Error('Twitch lieferte keinen Refresh-Token.');
    const scopes = payload.scope ?? this.tokens?.scopes;
    this.tokens = {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt: Date.now() + payload.expires_in * 1000,
      ...(scopes ? { scopes } : {}),
    };
    await this.store.save(this.tokens);
  }

  private resolveAuthorizationWaiters(): void {
    for (const resolve of this.authorizationWaiters.splice(0)) resolve();
  }
}

export class OAuthCallbackServer {
  private readonly pendingStates = new Map<string, number>();
  private readonly extraStates = new Map<string, Map<string, number>>();
  private server: http.Server | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly stateTtlMs: number,
    private readonly oauth: TwitchOAuth,
    private readonly logger: Logger = consoleLogger,
    private readonly additionalFlows: OAuthFlow[] = [],
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger.error('OAuth-Callback fehlgeschlagen.', { error: error instanceof Error ? error.message : 'unbekannt' });
        response.statusCode = 500;
        response.end('OAuth-Fehler. Details stehen im lokalen Log.');
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject).listen(this.port, this.host, () => resolve());
    });
    this.logger.info('Lokaler OAuth-Server gestartet.', { host: this.host, port: this.port });
  }

  get startUrl(): string {
    return this.makeStartUrl(this.oauth,this.pendingStates,'/oauth/callback');
  }

  startUrlFor(name:string):string {
    const flow=this.additionalFlows.find((item)=>item.name===name);
    if(!flow)throw new Error('Unbekannter OAuth-Freigabefluss.');
    let states=this.extraStates.get(name);if(!states){states=new Map();this.extraStates.set(name,states);}
    return this.makeStartUrl(flow.oauth,states,flow.callbackPath);
  }

  private makeStartUrl(oauth:TwitchOAuth,states:Map<string,number>,callbackPath:string):string {
    const state=randomBytes(24).toString('hex');states.set(state,Date.now()+this.stateTtlMs);
    const url=new URL(oauth.authorizationUrl);const redirect=url.searchParams.get('redirect_uri');
    if(redirect){const callback=new URL(redirect);callback.pathname=callbackPath;callback.search='';callback.hash='';url.searchParams.set('redirect_uri',callback.toString());}
    url.searchParams.set('state',state);return url.toString();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/oauth/start') {
      response.statusCode = 302;
      response.setHeader('Location', this.startUrl);
      response.end();
      return;
    }
    const flow=this.additionalFlows.find((item)=>item.startPath===url.pathname||item.callbackPath===url.pathname);
    if(flow?.startPath&&url.pathname===flow.startPath){response.statusCode=302;response.setHeader('Location',this.startUrlFor(flow.name));response.end();return;}
    if (url.pathname !== '/oauth/callback' && !(flow&&url.pathname===flow.callbackPath)) {
      response.statusCode = 404;
      response.end('Nicht gefunden. OAuth starten: /oauth/start');
      return;
    }
    const activeOauth=flow?.oauth||this.oauth, states=flow?(this.extraStates.get(flow.name)||new Map<string,number>()):this.pendingStates;
    const state = url.searchParams.get('state') || '';
    const expiresAt = states.get(state) || 0;
    states.delete(state);
    if (!state || expiresAt < Date.now()) {
      response.statusCode = 400;
      response.end('Ungültiger oder abgelaufener OAuth-State.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      response.statusCode = 400;
      response.end(`Twitch-OAuth abgelehnt: ${error}`);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.statusCode = 400;
      response.end('Kein OAuth-Code erhalten.');
      return;
    }
    await activeOauth.exchangeCode(code);
    response.statusCode = 200;
    response.end('OAuth erfolgreich. Dieser Tab kann geschlossen werden.');
    this.logger.info('Twitch-OAuth erfolgreich abgeschlossen.');
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`Twitch OAuth HTTP ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as T;
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};

export function tokenFileMode(filePath: string): number | undefined {
  try { return fsSync.statSync(filePath).mode & 0o777; } catch { return undefined; }
}
