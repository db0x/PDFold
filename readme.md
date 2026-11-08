# PDFold

Minimale Web-UI für [qpdf](https://qpdf.readthedocs.io/): PDFs per Drag & Drop hochladen, Reihenfolge per Drag & Drop festlegen, zusammengefügtes PDF herunterladen.

- Node.js 24, wenige npm-Pakete (pdf-lib, SortableJS, OverlayScrollbars) – vom eigenen Server ausgeliefert
- qpdf fügt zusammen und dreht, poppler (`pdftoppm`/`pdfinfo`/`pdfimages`) erzeugt Vorschauen, Infos und Halbseiten, pdf-lib baut das Halbseiten-PDF
- läuft im Docker-Container

## Start

```sh
docker compose up -d --build
```

→ http://localhost:3000

Ohne Compose:

```sh
docker build -t pdfold .
docker run --rm -p 3000:3000 pdfold
```

## Bedienung

1. PDFs auf die Seite ziehen (oder in das Feld klicken)
2. Karten per Drag & Drop in die gewünschte Reihenfolge schieben, × entfernt eine Datei
3. „Zusammenfügen“ klicken – die Datei wird nach dem ersten Dokument benannt

Querformat-Seiten werden beim Hochladen automatisch hochkant gedreht; der Dreh-Knopf je Dokument dreht um weitere 90°.

### A5-Halbseiten

Für gescannte A4-Seiten, auf denen nur eine Hälfte (A5) bedruckt ist:

1. „Halbseiten“ klicken – jede Seite wird in obere und untere Hälfte geteilt, leere Hälften werden erkannt und sind vorab abgewählt
2. Klick auf eine Hälfte wählt sie ab/an, Ziehen ändert die Reihenfolge, die Lupe vergrößert
3. „PDF erstellen“ – die gewählten Hälften werden lückenlos je zwei pro A4-Seite gestapelt

Die Hälften werden in der Auflösung des Scans (150–300 dpi) als Bild übernommen; verworfene Hälften sind damit vollständig aus dem Ergebnis entfernt.

## Konfiguration (Umgebungsvariablen)

| Variable   | Standard       | Bedeutung                                         |
|------------|----------------|---------------------------------------------------|
| `PORT`     | `3000`         | HTTP-Port                                         |
| `MAX_MB`   | `200`          | maximale Größe pro hochgeladener Datei            |
| `TTL_MIN`  | `60`           | hochgeladene Dateien werden danach gelöscht       |
| `DATA_DIR` | `/tmp/pdfold`  | Zwischenablage für Uploads (in Compose als tmpfs) |

## API

| Methode  | Pfad              | Beschreibung                                                     |
|----------|-------------------|------------------------------------------------------------------|
| `POST`   | `/api/upload`     | Body = PDF-Bytes, Header `X-Filename` → JSON mit `id`, `pages`, … |
| `GET`    | `/api/thumb/:id`  | PNG der ersten Seite                                             |
| `POST`   | `/api/merge`      | JSON `{ "ids": [...], "name": "..." }` → zusammengefügtes PDF    |
| `POST`   | `/api/rotate/:id` | JSON `{ "angle": 90 \| -90 \| 180 }` → dreht alle Seiten          |
| `POST`   | `/api/halves/prepare` | JSON `{ "ids": [...] }` → `sid` + Halbseiten mit Leer-Erkennung |
| `GET`    | `/api/halves/:sid/tile/:page` | Vorschaubild einer Seite                             |
| `GET`    | `/api/halves/:sid/half/:page/:pos` | große Vorschau einer Hälfte (`top`/`bottom`)    |
| `POST`   | `/api/halves/:sid/build` | JSON `{ "halves": [{ "page", "pos" }], "name" }` → PDF    |
| `DELETE` | `/api/halves/:sid` | Halbseiten-Sitzung löschen                                      |
| `GET`    | `/api/about`      | Version und Werkzeug-Versionen                                  |
| `DELETE` | `/api/file/:id`   | Upload löschen                                                   |

Hinweis: Kein Login – nur im eigenen Netz betreiben.
