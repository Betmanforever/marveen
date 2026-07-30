# Marveen zenom1 mentőokirat - egy FRISS, kontextus nélküli AI-agentnek

**Ha ezt olvasod:** Szabó Gábor átadott neked ezt a dokumentumot, mert a
"Marveen" nevű, otthoni szerveren (zenom1) futó AI-rendszer nem válaszol. Te
egy másik gépről (Gábor Windows-gépe) futó Claude Code (vagy más AI-eszköz)
vagy, ELŐZETES TUDÁS NÉLKÜL a Marveen rendszerről. Ez a dokumentum minden
információt tartalmaz, amire szükséged van a diagnózishoz és a
helyreállításhoz. Kövesd sorban.

## Mit NEM szabad tenned

- **NE módosíts kódot, konfigurációs fájlt, ütemezett feladatot.** A célod
  KIZÁRÓLAG a rendszer ÚJRAINDÍTÁSA a jelenlegi állapotában, nem a javítása
  vagy megváltoztatása.
- **NE próbálj Telegram-bot-tokent, `.env`-fájlt vagy más titkosított adatot
  kiírni/naplózni.** Ha valamit el kell mondanod Gábornak, írd le szövegesen
  MI történt, ne másold be a nyers fájltartalmat.
- **NE futtass semmilyen migrációs/cutover/swap scriptet** (ha találsz
  ilyeneket a `scripts/migration/` mappában) - azok EGY MÁSIK, tervezett
  folyamathoz tartoznak, nem vészhelyzeti helyreállításhoz.
- Ha bármi bizonytalan, vagy egy parancs hibát ad, amit nem értesz: **állj
  meg, és mondd el Gábornak egyszerű nyelven mit láttál** - ne találgass
  tovább.

## 1. Előfeltételek (ezeket Gábornak KELL előre beállítania - ha hiányoznak, ide írd le Gábornak mit kell tennie)

1. **NetBird VPN-kliens fusson ezen a Windows-gépen**, és legyen csatlakozva
   (ugyanazzal a fiókkal, amivel a zenom1 szerver is regisztrálva van). Ha nem
   fut, indítsd el a NetBird alkalmazást, és várj, amíg csatlakozik.
2. **SSH-hozzáférés zenom1-hez**: Gábor saját maga generál egy (korlátlan)
   SSH-kulcsot a Windows gépén, és a publikus felét ő teszi fel zenom1
   `~/.ssh/authorized_keys`-ébe - [a pontos kulcs-útvonal/parancs ide
   kerül, amint Gábor elvégezte ezt a lépést].
3. zenom1 hálózati címe: **`100.124.20.200`** (NetBird IP) vagy
   **`zenom1.netbird.cloud`** (NetBird FQDN) - MINDKETTŐ csak akkor érhető
   el, ha az 1. pont (NetBird) teljesül.

## 2. Diagnózis - lépésről lépésre

### 2.1. Elérhető-e egyáltalán a gép?

```
ping 100.124.20.200
```

- **Ha válaszol:** a gép fut, folytasd a 2.2 ponttal.
- **Ha NEM válaszol:** vagy a NetBird-kapcsolat hiányzik (ellenőrizd az 1.
  pontot), vagy a zenom1 gép maga van kikapcsolva/lefagyva. Ez utóbbi
  esetben **NINCS távoli áram-újraindítási lehetőség** (zenom1 egy HP ZBook
  laptop, se IPMI/BMC, se megbízható okos-dugalj-megoldás nem alkalmazható
  rá - lásd a dokumentum végén a részletet) - **FIZIKAI JELENLÉT SZÜKSÉGES
  a géphez, ez a dokumentum önmagában nem tud segíteni.**

### 2.2. Fut-e a Marveen a gépen?

SSH-val csatlakozva (a pontos parancsot lásd az 1.2 pontban), futtasd:

```
systemctl --user is-active mr-wolfe-dashboard.service mr-wolfe-channels.service
```

- **Ha mindkettő `active`:** a rendszer fut. Ellenőrizd, hogy a dashboard
  válaszol-e: `curl -sf http://localhost:3420/` (vagy nyisd meg böngészőben:
  `http://100.124.20.200:3420/`, ha a `WEB_HOST` be van állítva a géphez
  külső eléréshez). Ha ez is válaszol, a rendszer ÉLŐNEK tűnik - a probléma
  máshol lehet (pl. csak a Telegram-bot-kapcsolat akadt el, nem a teljes
  rendszer) - jelezd Gábornak pontosan mit láttál, ne indíts újra semmit
  feleslegesen.
- **Ha VALAMELYIK `inactive` vagy `failed`:** menj a 3. pontra (újraindítás).

### 2.3. Fut-e egyáltalán a szükséges "linger" beállítás?

```
loginctl show-user szabgabor | grep -i linger
```

Ennek `Linger=yes`-t kell mutatnia - ez garantálja, hogy a Marveen
szolgáltatásai a szerver újraindulása után IS automatikusan elinduljanak,
bejelentkezés nélkül. **Ha ez `Linger=no`-t mutat, ez önmagában megmagyarázza,
miért nem indult újra a rendszer egy géprestart után** - ezt jelentsd
Gábornak, ez egy konfigurációs hiba, amit NEKED NEM SZABAD magadtól
kijavítanod (`loginctl enable-linger szabgabor` a javítás, DE ezt csak akkor
futtasd, ha Gábor kifejezetten jóváhagyta, mert ez a rendszer viselkedését
tartósan megváltoztatja).

## 3. Helyreállítás - ha a szolgáltatások leálltak, de a gép fut és elérhető

```
systemctl --user start mr-wolfe-dashboard.service
sleep 5
systemctl --user start mr-wolfe-channels.service
```

Várj 30 másodpercet, majd ellenőrizd újra a 2.2 pont szerint. Ha most már
mindkettő `active`, és a dashboard válaszol, a helyreállítás sikeres -
**jelentsd Gábornak egyszerű nyelven, mi történt és mi lett az eredmény.**

Ha az újraindítás UTÁN is `failed` állapotot mutat valamelyik szolgáltatás,
nézd meg a hibaokot:

```
systemctl --user status mr-wolfe-dashboard.service --no-pager -l
journalctl --user -u mr-wolfe-dashboard.service -n 50 --no-pager
```

Írd le EGYSZERŰ NYELVEN Gábornak, mit találtál (ne csak a nyers hibaüzenetet
másold be - magyarázd el, mit gondolsz, mi történhetett), és **NE próbálj
saját magadtól mélyebb javítást** - egy szolgáltatás-újraindítás ÉS a
diagnózis megosztása a te felelősséged, a tényleges hibaelhárítás Gáboré
(mr-wolfe/neo agent bevonásával, ha a rendszer maga újra elérhető).

## 4. Ha a gép NEM válaszol semmilyen módon (2.1 pont "nem válaszol" ága)

Lásd a fenti nyitott kérdést a távoli áram-újraindításról. Ha nincs ilyen
lehetőség, ez a dokumentum itt véget ér - **fizikai jelenlét szükséges a
géphez.** Ha van hozzáférésed a fizikai géphez, egy egyszerű ki-be
kapcsolás/újraindítás után térj vissza a 2.1 ponthoz.

---

## Nyitott kérdések (Gábor/mr-wolfe kitöltendő, MIELŐTT ez a dokumentum élesbe kerül)

1. **LEZÁRVA (Gábor döntése, mr-wolfe msg 2312):** Gábor saját maga
   generál egy SSH-kulcsot a Windows gépén (NEM egy agent-kulcs másolatát
   átvéve - a flotta bevált mintája: saját terminál, nem agent-közvetített
   titok-átadás), és a publikus kulcsot ő maga teszi fel zenom1
   `~/.ssh/authorized_keys`-ébe. A korlátozott (`command=` forced-command)
   változatot Gábor kifejezetten elvetette ("no need for limitation") -
   sima, korlátlan kulcs lesz. A pontos kulcs-útvonalat ide kell majd
   beírni, amint elkészült.
2. **LEZÁRVA (élőben ellenőrizve, 2026-07-25):** zenom1 hardvere egy
   **HP ZBook Fury 15.6" G8 Mobile Workstation** (élő `dmidecode`-dal
   megerősítve) - vagyis egy LAPTOP, saját akkumulátorral (`BAT0`), NEM
   rack-szerver. Élőben ellenőrizve: NINCS IPMI-eszköz (`/dev/ipmi*` nem
   létezik), NINCS `ipmitool` telepítve, NINCS BMC/vezérlőkártya - ez a
   hardver-osztály (mobil munkaállomás) eleve nem is tartalmaz ilyet, ez
   NEM egy hiányzó beállítás, hanem a gép típusából következő, végleges
   korlát. **Egy külső "okos dugalj" megoldás SEM lenne megbízható itt**,
   pont mert LAPTOPRÓL van szó: egy okos dugalj csak az AC-tápot tudja
   megszakítani, a gép a SAJÁT AKKUMULÁTORÁRÓL simán tovább futna (vagy
   legjobb esetben is kiszámíthatatlanul viselkedne), tehát ez NEM adna
   megbízható, tiszta újraindítást, ahogy egy asztali gépnél tenné.
   **Végleges válasz: NINCS távoli áram-újraindítási lehetőség - egy
   teljes OS-szintű lefagyásnál FIZIKAI JELENLÉT SZÜKSÉGES a géphez.** Ez
   nem hiba vagy hiányzó beállítás, hanem a hardver-választásból (mobil
   munkaállomás, nem szerver) következő, dokumentált, végleges korlát.
   erősítette meg.
3. Ez a dokumentum jelenleg NEM tartalmazza a pontos SSH-parancsot (1.2 pont
   placeholder) - ezt az 1. nyitott kérdés megválaszolása után kell
   kiegészíteni.