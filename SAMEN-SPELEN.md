# ZONEFALL samen spelen

Er zijn twee manieren om ZONEFALL met andere mensen te spelen:

1. **Online via de website.** Niets installeren, werkt overal waar internet is.
2. **Via je eigen server (de app).** Eén persoon start de ZONEFALL-server op zijn computer, de rest speelt via die computer. Handig op hetzelfde netwerk (thuis, school, LAN-party) of als de publieke verbinding niet lukt.

In beide gevallen hebben de andere spelers alleen een browser nodig (Chrome, Edge, Firefox of Safari). Alleen degene die de server host heeft de app nodig.

---

## 1. Online via de website

Open de game:

- https://site-s-tau.vercel.app/zonefall/
- of https://tygovansteenpaal.github.io/Site-s/zonefall/

Beide adressen draaien dezelfde game en spelers op beide kunnen elkaar vinden.

### Met vrienden (privé)

1. Eén speler kiest **Private match** en klikt op **Create lobby**.
2. Bovenaan staat een **Lobby code** van 5 tekens. Deel die code, of klik op **Copy invite link** en stuur de link.
3. De anderen kiezen **Private match**, typen de code bij **Join with code** en klikken op **Join**. Met de invite link kom je direct in de lobby.
4. De match start vanzelf: 45 seconden nadat er 2 spelers zijn, of 10 seconden zodra er 6 zijn. De host (de speler die de lobby maakte) kan ook op **Start now** drukken.

Er kunnen tot 10 spelers in een lobby. Lege plekken worden gevuld met bots.

### Met willekeurige spelers

Kies **Quick play**. Je komt in een openbare lobby met iedereen die op dat moment zoekt. Ben je 75 seconden alleen, dan start een match tegen bots (of eerder met **Start now**). Wie daarna Quick play kiest, komt in een andere lobby, want een lopende match kun je niet in.

Wil je met vrienden spelen, gebruik dan **Private match** met een code. Dan zit je gegarandeerd in dezelfde lobby, en start de match pas als de host op **Start now** drukt of als er 2 of meer spelers zijn.

### Lukt verbinden niet?

De game verbindt spelers rechtstreeks met elkaar (WebRTC). Er is nog geen TURN-server die verkeer doorgeeft als dat niet lukt. Achter strenge routers, op 4G of 5G, en op school- of bedrijfsnetwerken komt die directe verbinding soms niet tot stand: je ziet elkaar dan niet in de lobby en iedereen start apart. Probeer een ander netwerk (bijvoorbeeld thuis wifi in plaats van mobiel) of speel via de eigen server hieronder op hetzelfde netwerk.

---

## 2. Via je eigen server (de app)

De host start de ZONEFALL-server. Die computer serveert de game en stuurt al het spelverkeer tussen de spelers door. Er is dus geen directe verbinding tussen de spelers nodig: ook op een school- of bedrijfsnetwerk werkt het, zolang de anderen de pagina kunnen openen. Lobbies op jouw server zijn alleen zichtbaar voor spelers op jouw server.

### De app downloaden

1. Ga op GitHub naar de repository en open het tabblad **Actions**.
2. Kies links **ZONEFALL server builds**.
3. Open de bovenste geslaagde run (groen vinkje). Is er geen recente, klik dan op **Run workflow** en wacht ongeveer 2 minuten.
4. Onderaan de run staan bij **Artifacts** twee downloads:
   - `ZONEFALL-Server-Windows` voor Windows
   - `ZONEFALL-Server-macOS` voor Mac
5. Download de juiste en pak het zip-bestand uit.

Je moet ingelogd zijn op GitHub om artifacts te downloaden. Artifacts blijven 90 dagen staan; daarna start je een nieuwe run.

### De app starten

**Windows**

1. Dubbelklik op `ZONEFALL-Server.exe`.
2. Krijg je "Windows heeft uw pc beschermd": klik op **Meer info** en daarna **Toch uitvoeren**. De app is niet ondertekend, daarom verschijnt die melding.
3. Vraagt Windows Firewall om toegang: sta toegang toe op **privénetwerken**.

**Mac**

1. Klik met de rechtermuisknop op `ZONEFALL-Server` en kies **Open**, daarna nogmaals **Open**.
2. Blokkeert macOS de app toch: ga naar **Systeeminstellingen > Privacy en beveiliging**, scrol naar beneden en klik op **Open toch**.
3. Vraagt de Mac of de app binnenkomende verbindingen mag accepteren: kies **Sta toe**.

Er opent een venster met de adressen, en de game opent in je browser:

```
On this computer:  https://localhost:8443/zonefall/
On your network:   https://192.168.1.20:8443/zonefall/
```

Laat dit venster open zolang er gespeeld wordt. Sluiten (of Ctrl+C) stopt de server.

**Zonder de app (met Python).** Heb je Python 3.10 of nieuwer, dan kun je ook in de map `server/` dubbelklikken op `Start ZONEFALL server (Mac).command` of `Start ZONEFALL server (Windows).bat`. De eerste keer installeert dat Flask, daarna start hij direct.

### Spelen op hetzelfde netwerk

1. Geef de anderen het adres achter **On your network** (bijvoorbeeld `https://192.168.1.20:8443/zonefall/`).
2. Ze zien de eerste keer een waarschuwing over het certificaat, omdat de server een eigen certificaat gebruikt. Kies **Geavanceerd** en daarna **Doorgaan naar ...** (in Safari: **Toon details** en **bezoek deze website**).
3. Daarna werkt alles zoals online: **Private match** met een code, of **Quick play**. Quick play vindt op jouw server alleen spelers die ook op jouw server zitten.

### Spelen via internet (zonder port forwarding)

Dit werkt ook op school, waar je de router niet kunt instellen.

1. Start de server en laat het venster open.
2. Open een tweede Terminal-venster en typ:
   ```
   ssh -R 80:localhost:8080 nokey@localhost.run
   ```
   Typ `yes` als gevraagd wordt of je wilt verbinden.
3. Er verschijnt een adres zoals `https://abc123.lhr.life`. Stuur dat adres met `/zonefall/` erachter naar je vrienden, en open het zelf ook. Iedereen speelt via dat adres.
4. Het adres verandert elke keer dat je de tunnel opnieuw start. Sluit je het venster, dan stopt de tunnel.

### Spelen via internet (met port forwarding)

1. Stel op je router **port forwarding** in: TCP-poort **8443** naar het lokale adres van de computer met de server (het adres achter "On your network").
2. Zoek je publieke IP-adres op, bijvoorbeeld via een zoekmachine met "wat is mijn ip".
3. Deel `https://<jouw publieke IP>:8443/zonefall/` met de anderen. Ook zij krijgen de certificaatwaarschuwing eenmalig.

### Instellingen

Start je de server vanuit een terminal, dan kun je opties meegeven:

| Optie | Wat het doet |
|---|---|
| `--port 9000` | Andere poort dan 8443 |
| `--no-browser` | Opent de game niet automatisch |
| `--http` | Gewoon HTTP in plaats van HTTPS. Alleen `localhost` kan dan online spelen. |
| `--tunnel-port 0` | Zet de HTTP-poort voor de tunnel (standaard 8080) uit |

Op `https://<adres>:8443/status` zie je hoeveel spelers verbonden zijn.

---

## Problemen

| Probleem | Oplossing |
|---|---|
| Vrienden zien de pagina niet | Zitten ze op hetzelfde netwerk? Klopt het adres, inclusief `https://` en `:8443`? Staat de firewall toegang toe? |
| "Je verbinding is niet privé" | Normaal bij de eigen server. Kies **Geavanceerd > Doorgaan**. |
| Lobby blijft op "Waiting for players" | Iedereen moet dezelfde code gebruiken, en op hetzelfde adres zitten (allemaal de website, of allemaal jouw server). |
| Een speler kan wel in de lobby maar niet verbinden | Het netwerk blokkeert directe verbindingen. Probeer een ander netwerk. |
| Mac zegt dat de app beschadigd is of niet geopend kan worden | Gebruik rechtermuisknop > **Open**, of **Privacy en beveiliging > Open toch**. |
