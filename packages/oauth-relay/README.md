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
  `target?code=…&state=…`. Při zamítnutí souhlasu uživatelem přijde od
  providera `?error=…&error_description=…&state=…` → `302` na
  `target?error=…&error_description=…&state=…`.
- Přebírají se **pouze** parametry `code`, `state`, `error`, `error_description`.
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
