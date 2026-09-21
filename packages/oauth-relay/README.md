# Hertz OAuth Relay (`@kuclab-hertz/oauth-relay`)

Minimalistický „bounce" server pro OAuth přihlašování. Bez závislostí —
pouze nativní `node:http` a `node:crypto`.

## Proč existuje

Hertz typicky běží na privátní IP (např. `http://192.168.100.161:4173`).
Google (a další provideři) **odmítají** registrovat redirect URI na privátní
IP adresy. Řešení:

1. V Google Cloud Console se jako redirect URI zaregistruje veřejná adresa
   relay, např. `https://oauth.kuclab.org/bounce`.
2. Google po přihlášení přesměruje prohlížeč na
   `https://oauth.kuclab.org/bounce?code=…&state=…`.
3. Relay ověří podpis ve `state` a prohlížeč okamžitě přesměruje (302) zpět
   na instanci: `http://192.168.100.161:4173/api/oauth/google/callback?code=…&state=…`.
4. Výměnu kódu za tokeny provede **instance svým vlastním client secretem**.

## Bezpečnostní vlastnosti

- Relay **nikdy nevidí tokeny** — pouze předává autorizační kód dál.
- **Neukládá kódy** — žádná databáze, žádný stav, čisté přesměrování.
- **Neloguje query parametry** — do logu jde jen metoda a cesta, nikdy `code`.
- `state` je HMAC-SHA256 podepsaný secretem, který zná jen instance a relay:
  formát `v1.<base64url(JSON)>.<base64url(HMAC)>`, payload
  `{ target, svc, iat, nonce }`. Platnost max. 10 minut.
- Open-redirect ochrana: `target` musí být absolutní `http(s)` URL.
  Privátní IP jsou záměrně povolené — právě na ně se přesměrovává.
- Povolené služby: `google`, `notion`.
- Při neúspěchu validace vrací prosté `400` bez vypsání parametrů.

## Nasazení (~10 minut)

### 0. Příprava

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz/packages/oauth-relay
```

Vygeneruj secret (tenhle klíč pak nastavíš i na instanci Hertze):

```bash
openssl rand -hex 32
```

### 1a. Varianta VPS + Caddy (doporučeno)

Na VPS s veřejnou IP a doménou (návrh: `oauth.kuclab.org`, lze změnit):

```bash
npm install --ignore-scripts   # jen typescript + @types/node pro build
npm run build
RELAY_STATE_SECRET=<vygenerovany-secret> RELAY_PORT=8090 npm start
```

Caddyfile (HTTPS zdarma přes Let's Encrypt, jedna řádka):

```caddy
oauth.kuclab.org {
    reverse_proxy 127.0.0.1:8090
}
```

Nebo Docker:

```bash
docker build -t hertz-oauth-relay .
docker run -d --name oauth-relay --restart unless-stopped \
  -e RELAY_STATE_SECRET=<vygenerovany-secret> \
  -p 127.0.0.1:8090:8090 hertz-oauth-relay
```

S nginx místo Caddy:

```nginx
server {
    listen 443 ssl;
    server_name oauth.kuclab.org;
    # ssl_certificate ... (např. od certbota)
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### 1b. Varianta Cloudflare Tunnel (bez veřejné IP a bez otevírání portů)

```bash
npm run build
RELAY_STATE_SECRET=<vygenerovany-secret> npm start   # běží na 127.0.0.1:8090
```

V druhém terminálu:

```bash
cloudflared tunnel --url http://127.0.0.1:8090
```

Cloudflare ti vypíše veřejnou `https://…trycloudflare.com` adresu —
pro trvalý provoz si v Cloudflare Zero Trust vytvoř pojmenovaný tunel
a namiř na něj vlastní doménu (např. `oauth.kuclab.org`).

### 1c. Varianta Vercel (zdarma, bez vlastního serveru)

Místo vlastního serveru může relay běžet jako funkce na Vercelu —
nemusíš mít VPS, doménu ani otevřené porty. Na bezplatném tarifu to
stačí: jeden bounce trvá pár milisekund a relay si nic nepamatuje.

**Krok 1 — projekt na Vercelu.** Založ si účet na
[vercel.com](https://vercel.com/) (jde se přihlásit přes GitHub).
V dashboardu klikni **"Add New…" → "Project" → "Import Git Repository"**
a vyber repozitář `Jerry256254/Hertz`. Protože je repozitář soukromý,
Vercel si vyžádá přístup ke tvému GitHubu — povol ho.

**Krok 2 — Root Directory.** V "Configure Project" klikni u položky
**Root Directory** na **Edit** a napiš:

```
packages/oauth-relay
```

**Krok 3 — Environment Variables.** Přidej proměnnou:

- **Name:** `RELAY_STATE_SECRET`
- **Value:** výstup příkazu `openssl rand -hex 32`

**Pozor, důležité:** tenhle secret si zapiš a později ho nastav
**úplně stejný** i na ferveru jako `HERTZ_OAUTH_STATE_SECRET`.
Server secretem podepisuje `state`, relay jím podpis ověřuje —
kdyby se hodnoty lišily, relay všechny požadavky odmítne.

**Krok 4 — Deploy.** Klikni **Deploy** a počkej na dokončení.
Výsledná adresa bude vypadat třeba takto:

```
https://<projekt>.vercel.app
```

(Jméno projektu jde v nastavení případně změnit — URL pak platí nová.)

**Krok 5 — ověření.** Otevři v prohlížeči:

```
https://<projekt>.vercel.app/bounce
```

Správná reakce je chybová hláška **"Neplatný nebo expirovaný
požadavek."** — endpoint žije a jen čeká na parametry od Googlu.

**Krok 6 — propojení s instancí.** Na ferveru nastav:

```
HERTZ_OAUTH_RELAY_URL=https://<projekt>.vercel.app
HERTZ_OAUTH_STATE_SECRET=<stejný secret jako v kroku 3>
```

a Hertze restartuj.

**Krok 7 — Google Cloud Console.** U OAuth klienta přidej do
**Authorized redirect URIs**:

```
https://<projekt>.vercel.app/bounce
```

(podrobněji viz sekce 2 níže — jen dosaď adresu svého Vercel projektu).

Pár poznámek na závěr: bezplatný tarif Vercelu na tohle bohatě stačí.
URL projektu je stabilní, dokud projekt nepřejmenuješ. A kdybys někdy
secret měnil, změň ho **na obou místech najednou** (Vercel i ferver),
jinak přihlašování přestane fungovat.

### 2. Redirect URI v Google Cloud Console

V [Google Cloud Console](https://console.cloud.google.com/) →
**APIs & Services → Credentials → OAuth 2.0 Client** přidej do
**Authorized redirect URIs**:

```
https://oauth.kuclab.org/bounce
```

(Pokud používáš jinou doménu nebo dočasnou adresu z tunelu, dosaď ji.)

### 3. Ověření

```bash
curl -i https://oauth.kuclab.org/healthz   # → 200 ok
curl -i https://oauth.kuclab.org/           # → krátké info
```

Zkus i neplatný bounce — musí vrátit prosté 400:

```bash
curl -i "https://oauth.kuclab.org/bounce?code=x&state=nesmysl"
```

## Konfigurace

| Proměnná             | Povinná | Výchozí   | Popis                                              |
| -------------------- | ------- | --------- | -------------------------------------------------- |
| `RELAY_STATE_SECRET` | ano     | —         | Tajný klíč pro HMAC podpis state (min. 16 znaků). Bez něj server odmítne start. |
| `RELAY_PORT`         | ne      | `8090`    | Port, na kterém server naslouchá.                  |
| `RELAY_HOST`         | ne      | `0.0.0.0` | Rozhraní, na kterém server naslouchá.              |

## API kontrakt (pro serverovou část Hertze)

- `GET /bounce?code=<code>&state=<state>` → `302` na
  `target?code=…` (target už v sobě nese vlastní vnitřní `state` instance,
  který se zachovává). Při zamítnutí souhlasu uživatelem přijde od
  providera `?error=…&error_description=…&state=…` → `302` na
  `target?error=…&error_description=…`.
- Přebírají se **pouze** parametry `code`, `error`, `error_description`.
  Relay `state` se pouze ověřuje (HMAC podpis) a dál se **nepředává**.
  Query řetězec cíle se zachovává — včetně jeho vnitřního `state`.
- `state = v1.<base64url(JSON)>.<base64url(HMAC-SHA256(rawPayloadB64, secret))>`,
  payload `{ target, svc: "google"|"notion", iat, nonce }`.
- Neplatný/podvržený/expirovaný state nebo nebezpečný target → `400`
  s prostým textem, bez vypsání parametrů.
- `GET /healthz` → `200` `ok`. `GET /` → krátké info.

Pomocné funkce pro podepsání state na straně instance:
`signState(payload, secret)` a `createNonce()` z `dist/state.js`
(stejný secret jako `RELAY_STATE_SECRET`).

## Vývoj

```bash
npm run build      # tsc -b
npm run typecheck  # tsc -b --noEmit
npm test           # node --test test/*.test.mjs
npm start          # node dist/index.js (vyžaduje RELAY_STATE_SECRET)
```
