# Hertz Jobs — kompletní návod (Grok-Bot režim)

Tento návod popisuje, jak z Hertz Jobs udělat autonomní platformu ve stylu Grok Botu: boti s vlastním počítačem, kteří pracují 24/7, sami se probouzejí na heartbeaty, učí se postupy jako skills, ptají se vás na citlivé akce a jsou dostupní z Telegramu a Discordu.

---

## 1. Instalace

### Varianta A: hotový balíček

```bash
npx kuclab-hertz
```

První spuštění otevře setup wizard (v prohlížeči): vytvoříte si admin účet (CEO), připojíte LLM providera (API klíč) a máte server běžet na `http://localhost:3000` (nebo portu z wizardu). Veškerá data žijí v `~/.kuclab-hertz/`.

Doporučený běh na serveru je přes tmux, aby práce pokračovala i po odhlášení:

```bash
sudo apt install tmux        # Debian/Ubuntu; Fedora: sudo dnf install tmux
tmux new -s hertz
npx kuclab-hertz
# detach: Ctrl-B pak D; zpět: tmux attach -t hertz
```

### Varianta B: build ze zdrojáků

Vyžaduje Node.js ≥ 20 a [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz
pnpm install
pnpm build
pnpm setup   # jen poprvé — síťová konfigurace
pnpm start   # server + WebUI (nebo pnpm hertz start)
```

---

## 2. Koncept: agenti = boti s vlastním počítačem

Každý projekt má **manažera** a jeho **zaměstnance**. Od této verze je každý zaměstnanec plnohodnotný autonomní bot:

| Schopnost | Jak se používá |
|---|---|
| Vlastní počítač | Docker kontejner per bot (viz sekce 3) |
| Proaktivita | Heartbeat — pravidelné samovzbuzení (sekce 4) |
| Bezpečné akce | request_approval — bot se předem zeptá (sekce 5) |
| Učení | Skills — bot si ukládá naučené postupy (sekce 6) |
| Dostupnost | Telegram/Discord kanály (sekce 7 a 8) |
| Práce s weby | Browser automatizace v kontejneru (sekce 9) |

Všechny běhy botů jdou přes **durable frontu úloh v databázi**. Když proces serveru spadne nebo se restartuje, Hertz při startu automaticky obnoví přerušenou práci tam, kde skončila — včetně opravy napůl dokončených tool volání. Nic se neztratí.

---

## 3. Vlastní počítač bota (Docker backend)

Ve výchozím stavu běží boti přímo na serveru (`local` backend). Pro izolaci ve stylu Grok Botu každému botu vytvořte vlastní kontejner.

### Krok 1: Postavte image počítače

Na stroji, kde běží Hertz:

```bash
docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
```

Image obsahuje Node.js, Python 3, git/gh, ripgrep, jq, sqlite3 a Playwright s Chromium (pro browser automatizaci).

### Krok 2: Přepněte bota na Docker

1. Otevřete projekt → detail zaměstnance.
2. Karta **Overview** → sekce **Počítač bota**.
3. Přepněte `local` → `docker`. Status badge ukazuje stav kontejneru (`running`, `stopped`, …).
4. Tlačítko **Restartovat** kontejner znovu vytvoří (např. po změně image).

Co kontejner dostává:

- vlastní filesystém; projekt i osobní složka bota jsou přimountované na stejných cestách jako na hostiteli, takže všechny nástroje fungují beze změny,
- limity: 2 GB RAM, 2 CPU, 512 procesů, `no-new-privileges`,
- `--restart unless-stopped` — po rebootu celého stroje se počítače botů samy vrátí,
- persistentní shelly bota běží **uvnitř** kontejneru.

Požadavek: na hostiteli musí běžet Docker daemon. Pokud není dostupný, Hertz bezpečně spadne zpět na `local` (zapíše varování do logu).

---

## 4. Heartbeat — proaktivní boti

Heartbeat = bot se v nastaveném intervalu **sám probudí**, podívá se, co má na starosti, a rozhodne se: pracovat dál, něco připravit, nahlásit — nebo odpovědět jen `(idle)` a zůstat v tichosti.

Nastavení: detail zaměstnance → **Heartbeat**:

- **Interval (minuty)** — `0` = vypnuto, např. `60` = každou hodinu.
- **Stálé instrukce** — co má při každém heartbeatu dělat, např.:
  ```
  Zkontroluj můj e-mail (Gmail konektor) a shrni důležité.
  Nové leady z formuláře zapiš do leads.md.
  Není-li co dělat, odpověz jen (idle).
  ```

Všechny heartbeauty jednoho bota vedou do jedné přehledné session „Heartbeat" — snadno dohledáte, co bot dělal na vlastní pěst. Heartbeaty nezaplňují paměť bota (auto-poznámky jsou u nich vypnuté).

Tip: kombinujte s rutinami (Project → Rutiny), pokud potřebujete přesný cron místo intervalu.

---

## 5. Schválení akcí (human-in-the-loop)

Před citlivými akcemi — odeslání e-mailu či zprávy vaším jménem, utracení peněz, publikace, mazání, kontakt třetích stran — bot zavolá `request_approval`, přesně popíše, co hodlá udělat, a **počká**:

1. Jeho session se parkne do stavu `awaiting_input`.
2. Požadavek se objeví ve WebUI → **Schválení** (položka v levém bočním panelu).
3. **Schválit** nebo **Zamítnout** — rozhodnutí se doručí zpět do session a bot automaticky pokračuje: při schválení provede akci přesně podle popisu, při zamítnutí ji vynechá (případně navrhne alternativu).

Schvalování funguje i v autonomous módu — právě proto, aby autonomie měla pojistku. Běžná rozhodnutí (jak krok implementovat, jakou knihovnu použít) bot řeší sam; schválení chce jen u akcí s reálnými důsledky.

---

## 6. Skills — boti se učí postupy

Když bot vyřeší opakovatelný úkol (report, nasazení, stažení dat s háčky), může si postup uložit jako skill:

- `save_skill {name, description, instructions, script?}` — uloží SKILL.md (+ volitelný script.sh),
- `list_skills` — index: název + kdy použít,
- `read_skill {name}` — kompletní postup,
- `delete_skill {name}` — smazání zastaralého.

Do promptu bota se dostává jen lehký index skills; plný text se načte až když situace odpovídá. Skills sledují bota napříč projekty (jsou jeho osobní knihovnou) a vy je vidíte v detailu zaměstnance → **Skills**.

V praxi: řekněte botu „ulož si tenhle postup jako skill weekly-report" — příště už ho jen provede.

---

## 7. Telegram kanál

Pište botům z mobilu; zpráva je probudí kdekoli.

1. V Telegramu napište [@BotFather](https://t.me/BotFather) → `/newbot`, pojmenujte ho, zkopírujte token (`123456:ABC-DEF…`).
2. Hertz → **Kanály** (admin sekce v bočním panelu) → **Připojit bota**:
   - typ: Telegram,
   - název: libovolný (např. „Můj asistent"),
   - token z BotFathera,
   - **výchozí agent**: který bot odpovídá, když chat ještě není spojen se session,
   - **povolené chaty**: ID konverzací oddělená čárkou (doporučeno!). Prázdné = smí psát kdokoli, kdo bota najde. Své chat ID získáte, když botovi napíšete a podíváte se do audit logu, nebo přes @userinfobot.
3. Napište botovi do Telegramu — vytvoří se nová session (vidíte ji ve WebUI jako běžný chat) a odpověď dorazí zpět do Telegramu.

Stejný chat zůstává svázaný se stejnou session, takže historie konverzace přetrvává. Více botů/kanálů lze provozovat paralelně.

---

## 8. Discord kanál

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → záložka **Bot** → Reset Token → zkopírujte token.
2. **Důležité:** zapněte **MESSAGE CONTENT INTENT** (záložka Bot, section Privileged Gateway Intents) — bez něj bot text zpráv neuvidí.
3. Pozvěte bota na server přes OAuth2 → URL Generator (scope `bot`; permize Read Messages + Send Messages).
4. Hertz → **Kanály** → typ Discord, token, výchozí agent. Do „povolených chatů" patří ID kanálů (pravý klik na kanál → Kopírovat ID; nejdřív zapněte Developer Mode v nastavení Discordu).
5. Napište v kanálu — odpověď přijde do téhož kanálu.

---

## 9. Browser automatizace

Botům s docker backendem jsou k dispozici nástroje `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_snapshot` a `browser_screenshot`.

Klíčová vlastnost: prohlížeč je **persistentní daemon uvnitř kontejneru** — přihlásíte se jednou (např. do Zendesku či administrace hostingu) a přihlášení vydrží i pro pozdější volání, stejně jako u člověka. Typický workflow zadáte přirozeně:

> „Přihlas se do mého Zendesku (údaje najdeš ve svém trezoru v notes/), projdi otevřené tickety a navrhni odpovědi. Před odesláním čehokoli mi dej schválit."

Screenshoty se ukládají do osobní složky bota (`self/materials/…`) — vidíte je ve file exploreru i on sám přes `read_file`.

Pozn.: browser nástroje se nabízí jen botům s docker backendem; `local` boti dostanou jasnou hlášku, že je potřeba přepnout backend.

---

## 10. Provoz 24/7 a spolehlivost

- **Crash recovery**: fronta úloh je v SQLite. Po restartu server Hertz sám znovu zařadí přerušené úlohy a obnoví session. V logu uvidíte `[hertz] recovered after restart: N session(s) resumed, M job(s) requeued`.
- **Retry providerů**: 429/5xx/výpadky sítě se opakují s exponenciálním backoffem (2 s → 5 s → 15 s) bez ohlášení chyby.
- **Auto-pokračování**: dlouhá autonomní práce nepolezne na turn limitu — běh se prodlouží a teprve po bezpečnostním stropu se korektně ukončí s poznámkou do paměti bota.
- **Pause/resume přežije restart**: zapauzovaná session jde po startu serveru resume tlačítkem znovu.
- **Hard-stop**: tlačítko Stop v chatu přeruší aktuální model call a run korektně uzavře.

---

## 11. Bezpečnost

- Tajnosti (API klíče, tokeny kanálů, MCP secrets) jsou šifrované AES-256-GCM pod master klíčem v `~/.kuclab-hertz/master.key` (mode 0600). Zálohujte ho — bez něj data nepřečtete.
- Kontejner bota nemá více práv, než potřebuje (limity prostředků, no-new-privileges); mountují se jen projekt a jeho osobní složka.
- Allowlist příkazů (`shell_exec`) platí i uvnitř kontejneru; persistentní shell je záměrně plný bash — každé spuštění jde do audit logu.
- PathGuard hlídá cesty všem nástrojům včetně zápisů z browser automatizace.
- Doporučujeme u kanálů vždy vyplnit povolené chaty; jinak smí s botem mluvit kdokoli, kdo ho najde.
- Bot nemůže mimo povolené kořeny projektu a svou osobní složku; vše ostatní odmítne a zaloguje se to.

---

## 12. Řešení problémů

| Symptom | Příčina / řešení |
|---|---|
| Docker backend: status `unavailable` | Neběží Docker daemon na hostiteli (`docker info`). Spusťte jej, nebo nechte bota na `local`. |
| Docker backend: kontejner hned padá | Chybí image `kuclab-hertz-computer:latest` — postavte jej dle sekce 3, poté Restartovat. |
| Browser nástroje hlásí, že chybí computer | Přepněte bota na docker backend. |
| Discord bot nereaguje na zprávy | Nezapnutý MESSAGE CONTENT INTENT v Developer Portalu. |
| Telegram: „No default agent" | V Kanálech nenastaven výchozí agent. |
| Kanál po změně tokenu nefunguje | PATCH uloží a restartuje gateway automaticky; zkontrolujte live badge na stránce Kanály. |
| Session visí ve stavu active po pádu | Nemělo by se stát — reconcile to řeší. Ruční pomoc: otevřít session → Stop, případně poslat novou zprávu. |
| Heartbeat spamuje paměť | Nejsou — heartbeaty auto-poznámky skipují; hluk znamená špatné standing instrukce (přidejte „nic nedělej → (idle)"). |

---

## 13. Co se pod kapotou změnilo (pro vývojáře)

- `packages/core/src/agent/agent-loop.ts` — AbortSignal, event-driven pauza, `stop()`, retry/backoff, auto-pokračování chunků, `repairSessionHistory()`, `suppressAutoMemory`.
- `packages/server/src/queue/job-queue.ts` — durable fronta (tabulka `jobs`) s concurrency limitem a backoffem.
- `packages/server/src/runtime/run-jobs.ts` — jediný vstupní bod všech běhů (`agent_run` job); rekonfiguruje sandbox/prompt z DB těsně před během.
- `packages/server/src/runtime/reconcile.ts` — boot reconciliation (requeue running jobů, resume aktivních session).
- `packages/server/src/computer/` — ComputerManager (kontejnery) + BrowserSession (Playwright daemon) + zdroj browser.mjs daemonu.
- `packages/server/src/channels/` — Telegram long-poll gateway, Discord gateway klient, ChannelManager (routing chat↔session).
- `packages/server/src/heartbeats/heartbeat-scheduler.ts` — intervalové samovzbuzení botů.
- `packages/server/src/tools/{approval,skill,browser}-tools.ts` — request_approval, skills, browser_*.
- Nové tabulky: `jobs`, `approvals`, `channel_configs`, `channel_bindings`; nové sloupce `agents`: `computer_backend`, `computer_image`, `heartbeat_minutes`, `heartbeat_prompt`, `last_heartbeat_at`.
