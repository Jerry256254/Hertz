# Standard pro GitHub repa (KucLab)

Návod, podle kterého se zakládá a udržuje **každé** KucLab repo (appky i
jiné projekty), aby všechna vypadala a fungovala stejně — stejná struktura,
stejné soubory, stejný formát commitů a releasů. Vychází z toho, jak je
postavené [KucLab Clock](https://github.com/Jerry256254/KucLab-Clock) — to
repo je referenční příklad "podle knihy".

Šablony souborů jsou v tomhle dokumentu níž, u sekce, ke které patří —
zkopíruj obsah code-blocku a nahraď všechny `{{PLACEHOLDERY}}`.

## 1. Povinné soubory v kořeni repa

Každé repo má vždy tyhle čtyři soubory, v tomto pořadí důležitosti:

| Soubor | K čemu je |
|---|---|
| `README.md` | Lidsky čitelný popis appky, návod k buildu, odkaz na stažení |
| `LICENSE` | Licenční text |
| `.gitignore` | Co git nemá sledovat (build artefakty, lokální konfigurace) |
| `store.md` | Strojově čitelná metadata appky pro automatizované tvoření store listingu |

Volitelně, pokud repo obsahuje kompilovaný build:
- `store/logo.png` — čtvercové PNG logo (512×512, RGBA), stejný motiv jako
  launcher ikona appky.
- `store/screenshots/NN_nazev.png` — screenshoty appky, číslované podle
  pořadí zobrazení (`01_`, `02_`, …), název odpovídá dané obrazovce.

## 2. Licence

Výchozí volba je vždy **MIT** (permisivní, nejjednodušší, běžná pro osobní
open-source projekty), pokud výslovně nepadne jiné rozhodnutí u
konkrétního projektu (např. GPL-3.0 pro copyleft). Držitel práv je vždy
"KucLab", ne osobní jméno, pro konzistenci napříč projekty.

```text
MIT License

Copyright (c) {{YEAR}} KucLab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. `.gitignore`

Pro Android/Gradle projekty použij tenhle základ beze změny. Pro jiný typ
projektu (web, Python, …) vyjdi ze stejného základu a dopiš jen to, co je
pro daný ekosystém navíc (`node_modules/`, `__pycache__/`, `.venv/`, …) —
základ (`.idea/`, `*.log`, OS soubory) zůstává vždy.

```gitignore
# --- Base (keep in every repo regardless of stack) ---
.idea/
*.iml
.vscode/
.DS_Store
Thumbs.db
*.log
.claude/

# --- Android / Gradle (remove this block for non-Android projects) ---
.gradle/
local.properties
build/
captures/
.externalNativeBuild/
.cxx/
*.apk
*.aab
*.ap_
*.dex
/app/release/
/app/debug/

# --- Add ecosystem-specific ignores below as needed, e.g.: ---
# node_modules/          (Node/JS)
# __pycache__/  .venv/    (Python)
# target/                (Rust/Java-Maven)
```

## 4. `README.md` — pevná struktura

README má vždy tyhle sekce, v tomto pořadí:

1. **Nadpis + jednořádkový popis** appky.
2. **Download badge/odkaz** hned pod nadpisem — vede na
   `<repo>/releases/latest`. Tohle je vždy hned nahoře, ne až na konci —
   repo má sloužit i ke stažení, ne jen jako zdrojovky.
3. **`## Funkce`** — odrážkový seznam hlavních vlastností appky.
4. **`## Design`** (pokud appka má vlastní vizuální identitu, jinak vynech).
5. **`## Sestavení ze zdrojového kódu`** — přesné buildovací příkazy.
6. **`## Technologie`** — jazyk/framework/závislosti jednou větou.
7. **`## Licence`** — odkaz na soubor `LICENSE`.

Žádné jiné sekce se nepřidávají bez důvodu — detailní popis a metadata
patří do `store.md`, README je stručný orientační bod.

```markdown
# {{APP_NAME}}

{{ONE_LINE_DESCRIPTION}}

[![Stáhnout nejnovější verzi](https://img.shields.io/github/v/release/{{GH_OWNER}}/{{GH_REPO}}?label=St%C3%A1hnout&style=for-the-badge&color=D97757)](https://github.com/{{GH_OWNER}}/{{GH_REPO}}/releases/latest)

**➡️ [Stáhnout z poslední verze](https://github.com/{{GH_OWNER}}/{{GH_REPO}}/releases/latest)**
— žádná registrace, žádný obchod, jen soubor ke stažení.
{{IF_ANDROID: V telefonu je potřeba povolit instalaci z neznámých zdrojů, appka není z Play Store.}}

## Funkce

- **{{FEATURE_1_TITLE}}** — {{FEATURE_1_DESC}}
- **{{FEATURE_2_TITLE}}**
  - {{FEATURE_2_DETAIL_A}}
  - {{FEATURE_2_DETAIL_B}}

## Design

{{DESIGN_LANGUAGE_DESCRIPTION}}

## Sestavení ze zdrojového kódu

{{BUILD_PREREQUISITES}}

\`\`\`bash
{{BUILD_COMMAND}}
\`\`\`

Výsledný balíček najdete v `{{BUILD_OUTPUT_PATH}}`.

## Technologie

{{TECH_STACK_ONE_LINER}}

## Licence

[{{LICENSE_NAME}}](LICENSE)
```

## 5. `store.md` — strojově čitelná metadata

Vždy v kořeni repa, vždy stejné schéma (`schema_version: 1`, dokud se pole
nezmění — pak naskoč na 2). YAML frontmatter (strojově parsovatelné) +
markdown tělo se stejným obsahem pro čitelnost na GitHubu.

Při každém novém releasu appky:
1. Zvýšit `version_name` / `version_code` (nebo ekvivalent verzování).
2. Nastavit `last_updated` na dnešní datum.
3. Přidat nový záznam **na začátek** pole `changelog` (nejnovější první).
4. Pokud se změnily screenshoty, přepsat soubory ve `store/screenshots/`
   se stejnými názvy — jen pokud se UI skutečně vizuálně změnilo.

```markdown
---
schema_version: 1
app_name: {{APP_NAME}}
package_id: {{PACKAGE_ID}}
version_name: "{{VERSION_NAME}}"
version_code: {{VERSION_CODE}}
last_updated: {{YYYY-MM-DD}}
license: {{LICENSE_NAME}}
category: {{CATEGORY}}
short_description: >-
  {{ONE_LINE_DESCRIPTION_MAX_80_CHARS}}
full_description: |-
  {{MULTI_LINE_DESCRIPTION_PARAGRAPH_1}}

  {{MULTI_LINE_DESCRIPTION_PARAGRAPH_2}}
tags:
  - {{TAG_1}}
  - {{TAG_2}}
repository_url: https://github.com/{{GH_OWNER}}/{{GH_REPO}}
download_url: https://github.com/{{GH_OWNER}}/{{GH_REPO}}/releases/latest
logo: store/logo.png
screenshots:
  - store/screenshots/01_{{SCREEN_1_NAME}}.png
  - store/screenshots/02_{{SCREEN_2_NAME}}.png
changelog:
  - version: "{{VERSION_NAME}}"
    date: {{YYYY-MM-DD}}
    notes:
      - {{WHAT_CHANGED_1}}
      - {{WHAT_CHANGED_2}}
---

# {{APP_NAME}}

{{ONE_LINE_DESCRIPTION_MAX_80_CHARS}}

## Popis

{{MULTI_LINE_DESCRIPTION_PARAGRAPH_1}}

{{MULTI_LINE_DESCRIPTION_PARAGRAPH_2}}

## Logo

![{{APP_NAME}} logo](store/logo.png)

## Screenshoty

| {{SCREEN_1_NAME}} | {{SCREEN_2_NAME}} |
|---|---|
| ![{{SCREEN_1_NAME}}](store/screenshots/01_{{SCREEN_1_NAME}}.png) | ![{{SCREEN_2_NAME}}](store/screenshots/02_{{SCREEN_2_NAME}}.png) |

## Odkazy

- Zdrojový kód: <https://github.com/{{GH_OWNER}}/{{GH_REPO}}>
- Stažení nejnovější verze: <https://github.com/{{GH_OWNER}}/{{GH_REPO}}/releases/latest>
- Licence: [{{LICENSE_NAME}}](LICENSE)
```

Pravidla schématu:
- `schema_version` se nemění, dokud se nezmění sada polí výše — pak +1.
- `changelog`: nejnovější záznam vždy PRVNÍ (unshift, ne push).
- `screenshots`: cesty relativní ke kořeni repa, číslované podle pořadí
  zobrazení v appce, název = obrazovka.
- `download_url` směřuje vždy na `/releases/latest`, nikdy na konkrétní tag.
- Markdown tělo pod frontmatterem je jen čitelná renderovaná kopie polí
  výše — drž ji v souladu s frontmatterem.

## 6. Konvence commitů

- Zprávy v **angličtině**, imperativ ("Fix widget…", "Add …", ne "Fixed"/"Adding").
- První řádek: stručné shrnutí (do ~70 znaků).
- Prázdný řádek, pak tělo vysvětlující **proč**, ne co (diff už ukazuje co) —
  zejména u oprav bugů: co byl symptom, co byla skutečná příčina.
- Žádné `git commit --amend` na už pushnuté commity, žádné force-push do
  `main` bez výslovného souhlasu.
- Nikdy necommitovat vygenerované/binární build výstupy (`*.apk`, `*.aab`,
  `build/`) — na to je `.gitignore`; jediné binárky v repu jsou `store/logo.png`
  a `store/screenshots/*.png`.

## 7. Verzování a GitHub Releases

- Git tag vždy ve formátu `vMAJOR.MINOR.PATCH` (např. `v1.1.0`), i když appka
  interně používá jen `MAJOR.MINOR` — patch `.0` se doplní, ať je tag vždy
  validní semver.
- Release title: `"{{APP_NAME}} vMAJOR.MINOR"`.
- Release notes: krátká věta o povaze balíčku (podepsaný/nepodepsaný,
  odkud instalovat) + `## Novinky` s odrážkami z `store.md`'s posledního
  `changelog` záznamu.
- Ke každému releasu přiložit built balíček jako asset, pojmenovaný
  `{{RepoName}}-v{{version}}.{{ext}}`.
- README's download badge/odkaz vždy směřuje na `releases/latest`, nikdy na
  konkrétní tag.

## 8. Postup pro založení nového repa (checklist)

1. `git init`, nastavit `user.name`/`user.email` lokálně jen pro tohle repo,
   pokud se liší od globálního nastavení.
2. Vyplnit šablonu z bodu 4 → `README.md`.
3. Vyplnit šablonu z bodu 2 → `LICENSE`, doplnit rok.
4. Zkopírovat `.gitignore` z bodu 3.
5. Vyplnit šablonu z bodu 5 → `store.md`.
6. Vygenerovat/vyexportovat `store/logo.png` (512×512) ze stejného motivu
   jako launcher ikona appky.
7. `git add -A`, první commit: `"Initial commit"` nebo `"Add <app> source"`.
8. Založit prázdné GitHub repo (bez auto-README/licence, ať nevznikají
   merge konflikty) přes `gh repo create <jméno> --public --source=. --remote=origin`.
9. `git push -u origin main`.
10. Jakmile je appka buildovatelná: `gh release create v0.1.0 <artefakt>
    --title "..." --notes "..."`, pak přidat/aktualizovat download badge
    v README.

## 9. Co zůstává na appku specifické (mimo tenhle standard)

Design appky samotné (paleta, typografie, animace) se řídí požadavky
konkrétního projektu, ne tímhle dokumentem — tenhle guide pokrývá jen
**GitHub/repo vrstvu** (soubory, formát, proces), ne kód appky.
