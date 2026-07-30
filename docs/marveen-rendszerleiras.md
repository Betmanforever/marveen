# Marveen rendszerleírás

**Verzió:** 1.4 (v1.0-1.3: 2026-07-30 14:45-15:30; v1.4: 15:45, a kódolás-szabály szűkítése Alex mérésére, plusz a context-guard javítás)
**Készítette:** mr-wolfe, 2026-07-30
**Megrendelés:** Szabó Gábor, 2026-07-30: "wolfe must prepare a system description document that will be archived and any system change should be logged there."
**Archívum helye:** zenom Drive (`zenom@zenom.hu`), `Marveen Backups` mellett
**Élő forrás:** `docs/marveen-rendszerleiras.md` a `marveen` repóban, `develop` ág

---

## 0. Hogyan használd ezt a dokumentumot

Ez a rendszer írásos gerince. Két szabály tartja életben:

1. **Minden rendszerváltozás ide kerül**, a 12. szakasz változásnaplójába: mi változott, miért, ki, mikor, és mi a visszaállítás módja. Kód-commit nem helyettesíti: a commit azt írja le *mit* tettünk, ez azt hogy *miért* és *mire épül*.
2. **Minden állítás mellett ott van, hogy mérés vagy feltevés.** Ahol `[MÉRT]` áll, az élőben ellenőrzött ezen a gépen, a jelzett dátummal. Ahol `[NYITOTT]`, az még nincs eldöntve. Ahol `[FELTEVÉS]`, azt nem verifikáltuk, és nem szabad rá építeni visszafordíthatatlan döntést.

A dátumozás nem formalitás: egy környezeti tény elavulhat, és a legdrágább hiba az, amikor egy leírás nem téved, hanem **aktívan elterel** a helyes eszköztől. Ez 2026-07-30-án három skillben egyszerre megtörtént (mindegyik azt állította, hogy nincs systemd dashboard-unit, holott van).

---

## 1. Mi ez a rendszer

Egy ágens-flotta, ami Szabó Gábor üzleti munkáját végzi. Öt Claude Code ágens fut párhuzamosan, mindegyik saját tmux session-ben, saját konfigurációs könyvtárral és saját Telegram botjával. Egy Node szolgáltatás (dashboard) tartja őket életben, továbbítja közöttük az üzeneteket, futtatja az ütemezett feladatokat, és webes admin felületet ad.

Az emberi kommunikáció **kizárólag Telegramon** megy, és **kizárólag mr-wolfe közvetítésével**. Ez szándékos: egyetlen szűrő és egyetlen felelős pont van Gábor felé.

`[MÉRT 2026-07-30]` Repó verzió `marveen v1.22.2`, ág `develop`.

---

## 2. Ágensek

| Ágens | Szerep | Modell `[MÉRT 2026-07-30]` | Kézbesítés |
|---|---|---|---|
| `mr-wolfe` | Koordinátor, Gábor felé az egyetlen csatorna | `claude-opus-5` | legacy |
| `neo` | Kód, infrastruktúra, deploy | `claude-fable-5` | hook |
| `ive` | Design, copy-fit, UX | `claude-opus-5` | hook |
| `alex` | CMO, marketing, tartalom | `claude-opus-5` | hook |
| `charlie` | CFO, pénzügy, unit economics | `claude-opus-5` | hook |

Alárendelt szakágensek (a fő ágensek hívják be): `auditor`, `skill-writer`, `devils-advocate`, `hard-coder`, `Explore`, `Plan`.

### 2.1 A modell-feloldás topológiája, és egy csapda

**Al-ágens** élő modellje: `agents/<név>/agent-config.json` → `readAgentModel()` (`src/web/agent-config.ts:62`) → `--model` flag (`src/web/agent-process.ts:1046`).

**Fő ágens** (mr-wolfe) modellje: a repó gyökerének `.claude/settings.json` fájlja.

`[MÉRT 2026-07-30]` **Csapda:** az `agents/mr-wolfe/agent-config.json` is tartalmaz `model` kulcsot (`claude-fable-5`), de az a fő ágens indításához **inert**. A valóság a `token_usage` táblából: mr-wolfe ma `claude-opus-5`-ön futott. Ugyanez a csapda más alakban: `agents/<név>/.claude-config/settings.json` `model` kulcsa is inert. Aki egy ágens modelljét a "nem jó" fájlból olvassa ki, hamis választ kap, és 2026-07-30-án ez meg is történt.

`[MÉRT 2026-07-30]` A `MODEL_ALIASES` **kis- és nagybetű-érzékeny**, és az `'opus'` alias még `claude-opus-4-8[1m]`-re mutat.

### 2.2 Kontextus-ablak

`[MÉRT 2026-07-30]` A tényleges ablak **kb. 1 000 000 token**, nem 200 000. Megfigyelt csúcsok (`token_usage`, `input + cache_read + cache_creation` egy kérésben): mr-wolfe 994 846, neo 979 701, ive 975 136, charlie 647 618, alex 308 528. Több mint 30 000 esemény futott 200 000 feletti kontextussal.

A kód ezt **rosszul tudja**: `src/context-guard.ts:74` csak `[1m]` suffix esetén ad 1M-et, a flotta viszont suffix nélküli ID-kkel fut. Következmény és javítás: kanban `57f432d4`. Jelenleg latens, mert a `store/context-guard.json` nem létezik, tehát a guard egyetlen ágensen sem aktív.

### 2.3 Profilok

`[MÉRT 2026-07-30]` `templates/profiles/`: `applier`, `default`, `developer-senior`, `marketer`, `researcher`, `sub-dev` mind `permissive`; `developer-junior` `strict`. A `marketer` és `researcher` 2026-07-27-én került `strict`-ről `permissive`-re, Gábor kifejezett engedélyével ("Bypass authorised"). A kemény tiltó szabályok változatlanok.

---

## 3. Szolgáltatások és időzítők

`[MÉRT 2026-07-30]` systemd **user** unitok (`~/.config/systemd/user/`):

| Unit | Állapot | Megjegyzés |
|---|---|---|
| `mr-wolfe-dashboard.service` | active/running | `ExecStart=/usr/bin/node dist/index.js`, `Restart=on-failure`, `KillMode=process` |
| `mr-wolfe-channels.service` | active/running | `ExecStart=scripts/channels.sh`, `Restart=always`, `RestartSec=10`, `KillMode=process` |
| `mr-wolfe-morning.timer` | 07:27 | reggeli napindító |
| `marveen-telegram-progress-watchdog.timer` | `06..21:*:00` | percenként, nappal |
| `marveen-inbox-starvation.timer` | `06..21:0/10` | 10 percenként, nappal |
| `marveen-site-monitor.timer` | `06..21:0/5` | 5 percenként, nappal |
| `marveen-memory-backup.timer` | `21:30`, `Persistent=true` | lásd 9. szakasz |

### 3.1 A `KillMode=process` szándékos

Mindkét fő szolgáltatásnál `KillMode=process`. Ok: a dashboard és a channels **sub-ágens tmux session-öket indít**, és a `control-group` alapértelmezés a unit újraindításakor elvinné őket. `[MÉRT 2026-07-30]` A `systemctl --user restart mr-wolfe-dashboard.service` **háromszor** futott le ezen a napon, mindhárom alkalommal mind a négy sub-ágens session túlélte.

**A kanonikus dashboard-restart tehát a systemd unit**, nem a kézi `lsof`-alapú indítás. A kézi út tartalék. Ez korábban három skillben tévesen fordítva szerepelt, gyökér-ok: a `scripts/start.sh:10` a slugot a `.env`-ből olvassa (`MAIN_AGENT_ID=mr-wolfe`), tehát a unit neve `mr-wolfe-dashboard.service`, és egy 2026-07-18-i ellenőrzés `list-unit-files | grep marveen`-t futtatott, ami üres.

### 3.2 Éjszakai szünet 22:00 és 06:00 között

Gábor állandó szabálya 2026-07-30-tól. A szünet a flotta által **kezdeményezett** aktivitásra és értesítésre vonatkozik: ha Gábor ír 23:00-kor, arra válaszolni kell.

`[MÉRT 2026-07-30]` Négy rétegben érvényesítve: cron feladatok `6-21` sávra, systemd időzítők `06..21` alakra, `store/auto-restart.json` napi időpontjai 06:10 és 06:25 közé (a kikapcsoltak is, hogy egy későbbi bekapcsolás ne sértse újra), és a kódoldal egy közös `src/quiet-hours.ts` modulban (`QUIET_START_HOUR = 22`, `QUIET_END_HOUR = 6`), amit a `heartbeat.ts`, a `reauth-healer.ts` és a `channel-monitor.ts` használ. Élesítés: commit `fbd24eb`, build 14:12:56, restart 14:13:14.

Semmi nem **indul** 21:55 után. Egy hosszan futó `dream-engine` (20:15) vagy `kanban-audit` (20:00) átcsúszhat 22:00-on; Gábor ezt kifejezetten kivételként fogadta el, nem alapesetként.

`[NYITOTT]` Negyedik értesítési út: a `channel-coordinator.ts` saját `sendAlert`-je (fatal-401 út) még nem esik a kapu alá. Szándékosan vár, mert a severity-kivétel kérdése (ébreszthet-e egy auth-kiesés éjjel) Gábor döntése. Kanban `3f6c8457`.

`[NYITOTT]` Feszültség Gábor két utasítása között: korábbi állandó szabálya "éjjel javíts, tanulj, építs tudást, álmodj", a mai szünet ezt kizárná. A jelenlegi megoldás a monitorozást és értesítést állítja le, a tudásépítést előrehúzza estére. Gábor döntése, hogy éjjel egyáltalán épüljön-e tudás.

---

## 4. Adattárolás

`[MÉRT 2026-07-30]` `store/claudeclaw.db`, SQLite, 40 292 352 byte. A fontos táblák:

| Tábla | Sorok | Mire |
|---|---|---|
| `token_usage` | 51 661 | ágens-telemetria |
| `task_runs` | 9 146 | ütemezett futások |
| `site_checks` | 4 148 | site-monitor |
| `agent_messages` | 3 044 | inter-agent üzenetsor |
| `conversation_log` | 2 403 | csatorna-napló |
| `tool_call_log` | 1 047 | eszközhívások |
| `memories` + `memories_fts` | 895 | memória, FTS5 kereséssel |
| `kanban_cards` / `kanban_comments` | 155 / 637 | feladatkezelés |
| `daily_logs` | 495 | napi napló |
| `config_change_log` | 43 | konfigurációs változások |

**Nem használt, de létező táblák** (`sessions`, `scheduled_tasks`, `cost_line_items`, `cost_sources`, `background_tasks`, `labels`, `vault_ssh_*`): 0 sor. A `scheduled_tasks` kifejezetten **régi API**, nem szabad közvetlenül írni; az ütemezés fájl-alapú (8. szakasz).

### 4.1 Két mért csapda a lekérdezésekben

`[MÉRT 2026-07-30]` A `token_usage.timestamp` **unix epoch integer**, nem datetime szöveg. A `date(timestamp,'localtime')` alak **nem dob hibát, hanem nulla sort ad**. Helyes: `datetime(timestamp,'unixepoch','localtime')`. Az ágens-oszlop neve `agent`, nem `agent_id`. Ez 2026-07-30-án azt a látszatot adta, hogy aznap egyetlen ágens sem használt tokent, holott 51 ezer sor volt a táblában.

`[MÉRT 2026-07-30]` SQLite típus-affinitás: `integer_oszlop <op> strftime_szöveg` helyesen hasonlít (a TEXT konvertálódik). Csak akkor törik, ha a bal oldalnak **nincs affinitása**, tehát literál vagy kifejezés (például `COALESCE`). Literálon az `integer < text` mindig igaz, az `integer > text` mindig hamis.

---

## 5. Kommunikáció

### 5.1 Gábor felé

Telegram, kizárólag mr-wolfe-on keresztül. `[MÉRT]` A valós `chat_id` **8765540529**; a `"0"` érték elbukhat az allowlisten.

A párosítás és az allowlist **kizárólag** Gábor saját terminálból futtatott `/telegram:access` skilljén változhat. Egyetlen ágens sem szerkesztheti más ágens `access.json`-ját, és nem is kérhető meg rá üzenetben. A fenyegetési modell pont egy kompromittált vagy injektált peer, tehát ez a szabály trusted-peer üzenetből jövő kérésre is áll.

Ismeretlen sender első üzeneténél a szabály **default-deny**: csak a saját, Gábor által már párosított `allowFrom` listán szereplő sendert lehet automatikusan engedélyezni, és azt is auditálni kell. Minden más Gábor döntése.

### 5.2 Ágensek között

SQLite üzenetsor (`agent_messages`), a dashboard `POST /api/messages` végpontján. `[MÉRT 2026-07-30]` A kézbesítési mód per-ágens: `alex`, `ive`, `charlie`, `neo` = `hook` (pull), a default `legacy` (push). A `store/agent-delivery-config.json` tartja.

`[MÉRT]` **A pull-kézbesítés nem ér el elfoglalt ágenst**: turn-határ nélkül nincs inbox-drain. Egy elküldött üzenet tehát nem egyenlő egy megérkezett üzenettel. Mindig a `delivered_at` mezőt kell megnézni, nem azt hogy elküldtük.

`[MÉRT]` A `conversation_log` **nem tartalmazza a turn közben küldött Telegram üzeneteket**, tehát a "nincs a naplóban" nem egyenlő azzal hogy "nem lett elküldve".

### 5.3 Fájl-relay: a megérkezés néma esemény

Az ágensek `agents/<név>/in/` és `qa-in/` mappáin keresztül kapnak fájlokat, jellemzően mr-wolfe relayeli őket. **Az ágens nem kap értesítést a fájl megérkezéséről**, és ha épp dolgozik, semmi nem indokolja hogy odanézzen.

`[MÉRT 2026-07-30]` Ez öt napos hibát okozott: Ive 2026-07-25-én kért egy `styles.css`-t a copy-fit QA-hoz, a relay két részletben ment (`zenom-v2-index.html` 22:11:22, `zenom-v2-styles.css` 22:27:35), és ő a QA-t 22:27:30-kor zárta, **öt másodperccel a második részlet előtt**. Két kör futott hiányos bemenettel, és két felesleges copy-aggály született belőle.

**Szabály innentől:** minden relayelt fájl megérkezéséről egysoros inter-agent jelzés megy (mi, hova, melyik kérésre válasz), és **részletekben érkező anyagnál minden részletről külön**. Az ágens oldali párja: kör lezárása előtt újra megnézni az `in/`-t, ha volt kért de meg nem kapott bemenet. A jelzés a hiba előtti kapu, az újraellenőrzés a hiba utáni háló.

---

### 5.4 Ki mit tud mérni: a scope-tulajdon szabálya

`[MÉRT 2026-07-30]` Koordinátorként a nap nagy részében más ágensek területéről kell állítani valamit, hogy egyáltalán lehessen routeolni. Erre a koordinátornak **nincs mérési felszíne**: nem látja bele a peer munkájába úgy ahogy a peer, és a fájl-időbélyegeit sem kérdezi le anélkül hogy szólna.

Az aznapi mérleg: mr-wolfe négy állítása dőlt meg méréssel, egyet sem ő talált meg, és **háromnak a tárgya egy másik ágens saját scope-jában volt** (mi van az `in/` mappájában, mikor írt egy fájlt, melyik két jelöltje ugyanaz). Ive hét másodperc alatt futtatta le az `ls`-t a saját mappájában; ugyanaz a koordinátornak köröket és egy hibás konklúziót jelentett.

**Szabály:** ha egy állítás tárgya egy másik ágens saját scope-jában van, a legolcsóbb verifikáció nem a következtetés, hanem **egy kérdés annak az ágensnek**. A mérés ott a legolcsóbb, ahol az adat lakik. Fordítva is áll: amiről a koordinátornál van az adat (Gábor korrekciói, a relay állapota, a flotta-topológia), azt ő adja tényként, ne hagyja hogy a peer következtessen rá.

---

## 6. Web dashboard és API

`http://localhost:3420`. Az `/api/*` végpontok Bearer tokennel védettek, a token a `store/.dashboard-token` fájlban van.

`[MÉRT 2026-07-30]` Létező végpontok: `/api/memories` (GET, POST, PUT, DELETE `/:id`), `/api/daily-log`, `/api/messages`, `/api/kanban` és `/api/kanban/<id>/comments`, `/api/schedules`, `/api/agents` és `/api/agents/<név>/{start,stop,restart,drain-inbox,drain-ack}`, `/api/token-usage`, `/api/vault`.

**Nem létezik** `/api/costs`. Ez 2026-07-30-án tényként került továbbadásra, tévesen.

Két apró, mért részlet: a kanban komment végpont mezőnevei `author` és `content` (nem `agent_id`), és a hoston **nincs `sqlite3` CLI és nincs `jq`**, tehát `python3 -c "import sqlite3/json"` a járható út.

---

## 7. Skillek és memória

`[MÉRT 2026-07-30]` 163 globális skill (`~/.claude/skills/`), 26 ütemezett feladat (`~/.claude/scheduled-tasks/`), 54 ágens-memória fájl, 56 mr-wolfe memória fájl.

A skillek három szinten töltődnek: név plusz leírás mindig, teljes SKILL.md ha releváns, segédfájlok csak ha kellenek. A SKILL.md 500 sor alatt tartandó.

**SKILL.md-t nem írunk kézzel.** A `skill-writer` szakágens írja és patch-eli, hogy a minőség független legyen attól melyik ágens vagy modell dolgozott a mögöttes feladaton.

---

## 8. Ütemezés

Fájl-alapú: `~/.claude/scheduled-tasks/<név>/` alatt `SKILL.md` plusz `task-config.json`. A runner 60 másodpercenként ellenőrzi, és a cél-ágens tmux session-jébe küldi a promptot. Következmény: **a feladat csak akkor fut le, ha a cél-ágens session-je fut.**

Két típus: `task` mindig szól az eredménnyel, `heartbeat` csak fontos vagy sürgős esetben.

Létrehozás és módosítás a `POST /api/schedules` végponton, illetve a `task-config.json` közvetlen írásával. `[MÉRT]` `PUT` végpont a módosításra **nincs**. A `scheduled_tasks` SQLite táblát nem szabad használni.

---

## 9. Mentés és visszaállítás

`[MÉRT 2026-07-30]` `scripts/nightly-memory-backup.py`, `marveen-memory-backup.timer` 21:30, `Persistent=true` (a WSL host éjjel gyakran alszik, a `Persistent` a következő indulásnál lefuttatja a kihagyott futást).

A lánc: titok-szűrés, lokális archívum, gzip és tar integritás-ellenőrzés, Drive kvóta-ellenőrzés, feltöltés, majd lokális retenció-nyesés csak sikeres feltöltés után. Retenció 14 nap napi szinten, hétfő promóció heti szintre. Cél: `Marveen Backups` a zenom Drive-on, folder id `1oNq21oKw7Bs6ww9Z0aUbS1FAqK9KlAez`.

**Kemény tiltás:** a mentés titok-mentes. `HARD_DENY_DIRS` tartalmazza a `store/`, a `~/.gmail-mcp/` és a `~/.claude/channels/` könyvtárat. Ha bármilyen token bekerülne, a futás megáll, és nem tölt fel semmit.

`[MÉRT 2026-07-30 14:41]` **Javítva és élesben verifikálva.** Kanban `139f8f1c`, commit `6bb9dcf`.

A hibatörténet érdemi, mert két premissza dőlt meg egymás után:

1. **Az eredeti hiba:** a szkript a **személyes** Drive tokennel hitelesített (`drive-personal.json`), de a cél-mappa a **zenom** Drive-on van, ezért HTTP 404. Nem token-lejárat és nem kvóta: cross-identity cél-eltévesztés. Árulkodó jel a journalban: a kvóta-ellenőrzés **átment** a személyes fiókon, tehát az identitás élt, csak nem látta a mappát.
2. **A javítási javaslatom is hibás premisszán állt.** Azt állítottam, hogy a `drive-zenom.json`-ra váltás egysoros megoldás, mert a fájl létezik. Neo lemérte: a token `invalid_grant`, tehát a csere csak a 404-et cserélte volna `invalid_grant`-ra. **A fájl létezése nem érvényesség.** Kiderült továbbá, hogy mr-wolfe működő MCP hozzáférése nem is ezt a fájlt használja, tehát az én sikeres reggeli feltöltésem nem bizonyította ennek a tokennek a jóságát.

A megoldás: **service-account domain-wide delegation token**. `[MÉRT]` A javítás utáni futás eredménye: `3 files processed, 8 753 778 B verified present in Drive`, a unit `Finished`, a FAILED állapot megszűnt.

Ezzel a `backup-offsite-upload-wolfe` ütemezett feladat (08:15) **duplikálna**, ezért 2026-07-30 14:45-kor **feltöltőről ellenőrzővé** alakult: a szkript exit-kódját, a lokális archívumot és a Drive-on lévő fájlok **méret-egyezését** hasonlítja, és csak hibánál jelez. Feltöltést csak mentőövként végez, ha a szkript bukott, de a lokális archívum ép. Az érték a függetlenségben van: két külön jel a lánc két végén.

Élő visszaállítási teszt 2026-07-30-án megtörtént.

---

## 10. Hozzáférés és titkok

**Vault:** `POST /api/vault`, AES-titkosított tárolás, `store/.vault-key`. Titok soha nem kerül logba, üzenetbe, fájlba vagy Telegramra.

`[MÉRT 2026-07-30]` Tartalom (csak azonosító és címke): `ibanguardian-ftp`, `zenom-ftp`, `zenom.lu-ftp`, `filezilla-cli-key`, `Guardian HUB wifi`, plusz a 2026-07-30-án felvett felhasználónév-bejegyzések: `ibanguardian-ftp-user`, `zenom-ftp-user`, `zenom.lu-ftp-user`, `zenominvoice-ftp-user`.

**Kredencial-kezelés szabályai:**
- Titkot Telegramon nem kérünk és nem fogadunk el. Csak a vault.
- Felhasználónév nem titok, sima üzenetben mehet.
- Kredenciált nem próbálgatunk. Az ISPConfig hoston fail2ban lehet, és egy kizárás a deploy előtt a legdrágább kimenet.

`[MÉRT 2026-07-30]` **Két független credential-világ, és ez a nap legdrágább félreértése volt.** Az MCP szerverek auth-útja és a szkriptek token-fájljai (`~/.gmail-mcp/*.json`) **külön rendszerek**: az egyik élete semmit nem mond a másikról. Konkrétan: mr-wolfe zenom MCP hozzáférése hibátlanul feltöltött a `Marveen Backups` mappába, miközben ugyanannak az identitásnak a *token-fájlja* (`drive-zenom.json`) `invalid_grant` volt. Ezért egy javítási javaslat, ami "ugyanaz az identitás, tehát működni fog" alapon áll, hamis. A token-fájl **létezése nem érvényesség**, és egy sikeres MCP-művelet nem verifikálja a fájl-alapú utat. Aki tokent cserél, azt méréssel kell igazolnia, apró teszt-fájllal, nem a végleges hasznos tartalommal.

**Google identitások:** `zenom@zenom.hu` a Workspace fő fiókja, minden más `zenom.hu` cím **alias** rá, beleértve a `gabor.szabo@zenom.hu`-t. A személyes fiók (`szabgabor1@gmail.com`) Gábor Windows desktopján beállított fiókja, azt nem bántjuk.

`[MÉRT 2026-07-30]` mr-wolfe-nak minden Google assethez van joga, tehát a zenom Drive-hoz is. Gábor döntése szerint **minden ágens rajta keresztül ér el Google erőforrást**, és ez egyben szűrő is.

---

## 11. Web ingatlanok

`[MÉRT 2026-07-30]` `zenom.hu` és `zenom.lu` ugyanazon az IP-n (79.172.213.35, grafiszerver.hu, ISPConfig), de **két külön site, két külön docroot**. Bizonyíték: minden útvonalon azonos a fájlméret, de különbözik az inode és az mtime (zenom.hu július 14., zenom.lu július 28.). A bájtazonosság egy 07-28-i placeholder-másolás lenyomata.

**Fontos módszertani tanulság:** az `sha256` azt bizonyítja, hogy a tartalom egyenlő, a tárolásról semmit. Alias-kérdésre az `ETag` és a `Last-Modified` a helyes eszköz. Ez a tévedés 2026-07-30-án egy domain-stratégiai kérdés keretét rontotta el.

**Következmény:** egy feltöltés nem szolgálja ki mindkét domaint, tehát minden deploy két FTP fiókkal, két docrootba megy.

Gábor 2026-07-30-i döntése: a két site átmenetileg külön marad, egységes tartalommal, de a tartalom divergenciájára kell készülni. Nyelvek: **EN, DE, FR**, mind a legújabb (V2) designon; a magyar, lengyel és szlovák átmenetileg kiesik, átirányítással, nem törléssel.

`[MÉRT 2026-07-30]` **Élesben, mindkét domainen, független audittal ellenőrizve:** `/de/` és `/fr/` 200, a gyökér EN V2 (mindhárom `h2=6`, tehát V2 szerkezet), `/en/`, `/hu/`, `/pl/`, `/sk/` mind 301 a saját domain gyökerére. A német lapon `html lang="de"`, canonical `https://zenom.hu/de/` **mindkét** domainen, hreflang szett `de, en, fr, x-default`, a nyelvváltó `English / Deutsch / Français` saját nyelvi nevekkel, két adatvédelmi link `hreflang="en"` jelöléssel, és a kapcsolatűrlap rejtett `lang` mezője `de` (ez volt Ive funkcionális lelete: klónozáskor `en`-en maradt volna, és a backend rossz nyelvűnek látta volna a megkereséseket). Assetek mind 200.

Canonical: amíg a tartalom valóban azonos, mindkét site a `zenom.hu`-ra kanonizál, hogy ne versenyezzünk magunkkal. A divergenciakor fordul önmagára.

### A kódolás és a szabályozott terminológia mint kockázat

`[MÉRT 2026-07-30]` Alex FR forrás-glossaryja technikai okból ékezet nélkül készült, és nem csak a marketing-copy, hanem a **glossary** és az idézett CSSF-címek is törött alakban álltak benne: `Agrement` 2, `conformite` 2, `systeme` 5, `delegataires` 1, `reglemente` 6 előfordulás, mindössze 3 helyesen ékezetes karakter mellett. Az **élő** lapon viszont lemérve **nulla** ékezet nélküli szabályozott terminus van kint (`système` és `réglementé` helyesen, a CSSF-hivatkozásban az `opérations` is): Neo a build során kézzel állította helyre az ékezeteket. A kockázat tehát a forrás-dokumentumban élt, nem a kimenetben, de az út törékeny volt, mert emberi figyelmen állt.

**Ez NEM flotta-szintű minta, és ezt Alex mérte le, miután egy túl tág állítást írtam ide.** Ive DE draftja rendesen ékezetes (Alex mérése: 57 umlaut és eszett találat a német szettben). A defekt Alex saját fájljára volt specifikus. Ha "minden nyelvi változatra áll" formában maradt volna itt, valaki előbb-utóbb elvégzett volna egy felesleges német javító kört, és a dokumentum többet állított volna mint amit tudunk.

A **helyes, szűkebb szabály**, ami viszont nyelvfüggetlen és átvihető:

1. Ha egy forrásdokumentum bármilyen okból **nem a cél-kódolásban** áll (ASCII-ra szorított szöveg, escape-elt karakterek, transzliterált nevek), akkor a dokumentumnak **magának** kell tartalmaznia a mérvadó, másolásra kész változatot, vagy egy explicit mutatót rá. Egy figyelmeztetés hogy "ezt át kell írni" **nem kontroll**, mert a következő olvasón múlik. Alex saját precedense: ő maga sértette meg, majd készített egy mérvadó ékezetes szettet és kibővítette a régi fájl figyelmeztetését.
2. A **szabályozott terminológia** (glossary, jogi szöveg, hatósági hivatkozás) más kockázati osztály mint a marketing-copy, és szigorúbb kezelést kap. Egy törött marketingmondat rossz stílus; egy pontatlan szakszó egy compliance-piacon azonnal látható szakmai hiba. A referencia-anyag és a kimenő copy **két külön kockázati felület**, és a glossary-terminusok nagy része ki sem kerül a deployolt szövegbe.

**Módszertani megjegyzés a méréshez:** magyar nyelvű dokumentumban a német umlaut keresése (`ö`, `ü`) **szennyezett**, mert a magyar is használja ezeket. A német ékezetesség mérésére vagy a német szakaszra kell szűkíteni, vagy a magyarban nem szereplő jeleket (`ä`, `ß`) kell számolni.

`[NYITOTT]` GDPR: mind a hat élő nyelvi lap ugyanarra az **angol** `privacy.html` és `legal.html` fájlra mutat, lefordított változat nem létezik. A német lapon a hozzájáruló checkbox németül kér hozzájárulást egy angol tájékoztatóhoz. Átmeneti enyhítés bevezetve (`hreflang="en" lang="en"` a linkeken), ez nem oldja meg a jogi kérdést. Az Impressum kérdése szintén nyitott, jogi döntés.

---

## 12. Változásnapló

Minden rendszerváltozás ide kerül. Formátum: dátum, mi változott, miért, ki, visszaállítás.

| Dátum | Változás | Miért | Ki | Visszaállítás |
|---|---|---|---|---|
| 2026-07-30 | Éjszakai szünet 22:00 és 06:00 között: 4 cron feladat, 4 systemd időzítő, `auto-restart.json` napi időpontok | Gábor állandó szabálya | mr-wolfe | `.bak-nightpause` fájlok a unitok mellett, cron a `task-config.json` `notes` mezőjében dokumentálva |
| 2026-07-30 | Közös `src/quiet-hours.ts` modul, 3 értesítési út alá vonva, `QUIET_START_HOUR` 23-ról 22-re | Ugyanaz; a `reauth-healer` 1 órát tévedett, a `heartbeat` alsó határ nélkül volt, a `channel-monitor` kapu nélkül | neo (hard-coder), review neo, élesítés mr-wolfe | `git revert fbd24eb`, majd build és restart |
| 2026-07-30 | `src/web/token-usage.ts`: `discoverAgentSources()` scoped ágens-könyvtárakat is olvas | 22 nap sub-ágens telemetria hiányzott | neo | `git revert 7233914` |
| 2026-07-30 | `templates/profiles/marketer.json` és `researcher.json`: `strict` → `permissive` | Gábor kifejezett engedélye 2026-07-27 | mr-wolfe | a két fájlban visszaírni `strict`-re |
| 2026-07-30 | 4 FTP felhasználónév a vaultba | Gábor kérése; a jelszavak megvoltak, a nevek nem | mr-wolfe | vault bejegyzések törlése |
| 2026-07-30 | `backup-offsite-upload-wolfe` ütemezett feladat, 08:15 | A szkript saját Drive-feltöltése bukott; az offsite leg mr-wolfe MCP hozzáférésére került | mr-wolfe | a feladat kikapcsolása a dashboardon |
| 2026-07-30 | Kanban `09020484` prioritás high → low, cím átírva | A "200k ablak" premissza megdőlt, a valóság kb. 1M | mr-wolfe | kártya prioritás visszaállítása |
| 2026-07-30 14:41 | `scripts/nightly-memory-backup.py`: offsite feltöltés service-account DWD tokenre | A személyes token 404-et adott a zenom-drive mappára, a `drive-zenom.json` pedig `invalid_grant` | neo, diagnózis mr-wolfe | `git revert 6bb9dcf` |
| 2026-07-30 14:45 | `backup-offsite-upload-wolfe` ütemezett feladat: feltöltő → ellenőrző | A szkript feltöltése helyreállt, két feltöltő duplikálna | mr-wolfe | a `SKILL.md` és `task-config.json` visszaírása a feltöltő változatra |
| 2026-07-30 | zenom deploy: EN, DE, FR mind V2 designon, **mindkét** docrootba; HU, PL, SK 301-tel a saját domain gyökerére | Gábor döntése; a törlés 404-et gyártott volna indexelt URL-ekre | neo, audit mr-wolfe | a `deploy-dist-de-20260730` előtti állapot a repóban, a kiesett nyelvek fájljai megtartva |
| 2026-07-30 15:45 | A kódolás-kockázat állítása SZŰKÍTVE: nem flotta-szintű minta, hanem forrásdokumentum-szabály | Egy túl tág állítást írtam a permanens dokumentumba; Alex lemérte hogy a DE draft rendesen ékezetes (57 találat), tehát a defekt az ő fájljára volt specifikus | alex mérése, javítás mr-wolfe | a bővebb állítás visszaírása, de az felesleges javító köröket indítana |
| 2026-07-30 15:30 | Scope-tulajdon szabály: peer saját scope-járól szóló állítás előtt kérdés, nem következtetés | 4 megdőlt állításból 3 tárgya másik ágens scope-jában volt | mr-wolfe, Ive megfigyelésére | a szabály elhagyása |
| 2026-07-30 15:25 | Mérvadó ékezetes FR string-szett, a glossary és a CSSF-címek javítva | Az ékezet nélküli forrásfájlból másolás szabályozott terminológiát propagált volna hibásan | alex, mérés mr-wolfe | a régi fájl visszavétele mérvadóként |
| 2026-07-30 15:10 | Fájl-relay szabály: minden relayelt fájl megérkezéséről egysoros inter-agent jelzés, részletekben érkezőnél mindegyikről | Ive öt napig hiányos bemenettel dolgozott, mert a fájl megérkezése néma esemény | mr-wolfe, Ive javaslatára | a szabály elhagyása, de akkor a hibaosztály visszatér |
| 2026-07-30 | Német statement H2 második sora: `Scharf genug, es zu durchschlagen.` | Gábor választása (a `scharf` "clever" jelentése miatt); a `durchzuschlagen` alak nyelvtanilag hibás, ezt Ive és Gábor egymástól függetlenül állapította meg | Gábor dönt, neo épít | a `deploy-dist` korábbi sora |

### Nyitott tételek, amikre a napló következő bejegyzései épülnek

| Kanban | Mi | Kinél |
|---|---|---|
| `139f8f1c` | backup cross-identity 404, token-javítás | neo |
| `57f432d4` | `contextLimitForModel` 200k bázis 1M-es modellekre | neo |
| `3f6c8457` | quiet-hours 4. lyuk, `channel-coordinator.ts` | neo, Gábor severity-döntésére vár |
| `6a25e4ed` | zenom EN, DE, FR V2 deploy két docrootba | neo |
| `09020484` | session-belépő higiénia | neo, alacsony prioritás |

---

## 13. Amit ez a dokumentum nem tartalmaz

Szándékosan kimarad: a kanban tartalma (élő, a dashboardon), a memória tartalma (élő, SQLite plusz fájlok), az egyes skillek leírása (a skill-index a forrás), és a napi napló (élő). Ez a dokumentum a **szerkezetet** írja le, nem az állapotot. Aki az állapotot keresi, a dashboardon találja.
