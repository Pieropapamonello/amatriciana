---
title: Matrice Orari
emoji: 📅
colorFrom: green
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# 📅 Matrice Orari

Web app single-page per la visualizzazione e generazione della **matrice settimanale dei turni di lavoro** per **Dipendenti** e **Tutor**.

🔗 **Live demo:** [amatriciana.vercel.app](https://amatriciana.vercel.app)

---

## ✨ Funzionalità

- 👤 **Due ruoli** supportati: Dipendente (ciclo 18 settimane) e Tutor (ciclo 15 settimane)
- 📆 **Generazione automatica** fino a fine anno dalla settimana di partenza selezionata
- 🕐 **Monte ore configurabile**: 20h · 30h · 33h · 40h settimanali (menu a tendina)
- 🗓️ **Festività italiane** rilevate automaticamente (Pasquetta inclusa)
- 🌙 **Tema light/dark** commutabile
- 📊 **Vista tabella**, **vista schede** e **vista calendario mensile**
- 📸 **Esportazione PNG** e **condivisione** nativa (Web Share API / Clipboard / download)
- 🔒 **Pannello admin** protetto da password per gestire il team
- 👥 **Gestione team**: aggiungi/modifica/elimina colleghi con ciclo, ruolo e team personalizzati
- 🔍 **Trova Collega**: chi è in turno in un dato momento? Vista tabella, schede e matrice colleghi
- 🔄 **Scambi Orari**: cerca colleghi disponibili per scambiare un turno o un intero giorno, con validazione contrattuale (11h riposo, 5 giorni consecutivi) calcolata sul post-scambio
- ☁️ **Sincronizzazione Firebase Firestore**: dati persistenti su tutti i dispositivi
- 💾 Fallback **localStorage** se Firebase non è disponibile

---

## 🏗️ Struttura del progetto

```
matrice visual/
├── index.html          # Applicazione completa (single file)
├── api/
│   └── auth-config.js  # Serverless function Vercel — espone credenziali Firebase
├── vercel.json         # Configurazione deploy
└── README.md
```

L'intera app è contenuta in un singolo `index.html` — nessuna dipendenza da installare, nessun build step.

---

## 🔐 Admin & Firebase

L'accesso al pannello **Team** è protetto da password admin. Le credenziali non sono mai nel codice Git: vengono caricate a runtime dall'endpoint `/api/auth-config` che le legge dalle **variabili d'ambiente Vercel** (`FB_EMAIL`, `FB_PASS`).

### Setup variabili Vercel
```
FB_EMAIL = <email utente Firebase Authentication>
FB_PASS  = <password utente Firebase Authentication>
```

### Regole Firestore consigliate
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /userdata/main {
      allow read, write: if request.auth != null;
    }
  }
}
```

---

## 🔄 Pattern turni

### Dipendente — ciclo 18 settimane
Ogni settimana ha un orario di inizio e 2 giorni di riposo fissi. Alcune settimane hanno override specifici per Sabato/Domenica.

### Tutor — ciclo 15 settimane
| # | Orario | Riposi | Override weekend |
|---|--------|--------|-----------------|
| 1 | 12:00 | Mer, Sab | Dom → 12:00 |
| 2 | 06:00 | Mar, Sab | Dom → 06:00 |
| 3 | 18:00 | Mer, Dom | Sab → 18:00 |
| 4 | 15:00 | Sab, Dom | — |
| 5 | 06:00 | Gio, Dom | Sab → 06:00 |
| 6 | 18:00 | Lun, Sab | Dom → 18:00 |
| 7 | 12:00 | Mar, Dom | Sab → 12:00 |
| 8 | 08:00 | Sab, Dom | — |
| 9 | 18:00 | Mar, Sab | Dom → 18:00 |
| 10 | 12:00 | Lun, Sab | Dom → 12:00 |
| 11 | 06:00 | Mer, Dom | Sab → 06:00 |
| 12 | 11:00 | Sab, Dom | — |
| 13 | 12:00 | Gio, Dom | Sab → 12:00 |
| 14 | 06:00 | Lun, Sab | Dom → 06:00 |
| 15 | 18:00 | Gio, Dom | Sab → 18:00 |

> Il turno `18:00` è speciale: l'orario di inizio viene ricalcolato come `mezzanotte − monte ore`, con fine sempre a `00:00`.

---

## 🚀 Deploy

Il progetto è deployato su **Vercel** con auto-deploy su push al branch `master`.

```bash
git add .
git commit -m "descrizione modifica"
git push
```

---

## 📦 Dipendenze esterne (CDN)
- [Inter Font](https://fonts.google.com/specimen/Inter) — Google Fonts
- [Font Awesome 6.5](https://fontawesome.com/) — icone
- [html2canvas 1.4.1](https://html2canvas.hertzen.com/) — export PNG
- [Firebase 9 compat](https://firebase.google.com/) — Auth + Firestore

---

## 📋 Changelog

| Versione | Data | Note |
|----------|------|------|
| **v1.14.7** | 2026-02-26 | Fix: scambi bilaterale → escludi se anche solo un giorno è un no-op (OR invece di AND) |
| **v1.14.6** | 2026-02-26 | Fix: usa dayMe (non matrice) per rilevare no-op su myISO nello scambio bilaterale |
| **v1.14.5** | 2026-02-26 | Fix: escludi scambi inutili in cui otterresti lo stesso orario già in possesso (bilaterale) |
| **v1.14.4** | 2026-02-26 | Feat: Scambi Orari mostra tutte le opzioni valide, non solo la corrispondenza esatta (sezioni: esatta · altre opzioni · problemi contrattuali) |
| **v1.14.3** | 2026-02-26 | Fix: validazione 11h scambio bilaterale usa giorni post-scambio; fix display turno collega su targetISO |
| **v1.14.2** | 2026-02-26 | Scambi Orari: aggiunto campo "il giorno che ho" per scambio bilaterale tra giorni diversi |
| **v1.14.1** | 2026-02-26 | Scambi Orari: redesign completo — scansiona tutti i colleghi, non richiede più matrice propria |
| **v1.14.0** | 2026-02-26 | Export PNG font più grandi; card "Colleghi del Team"; campo Team nel modale collega; vista schede nella matrice colleghi; raggruppamento colleghi per ruolo+team; Scambi Orari ridisegnato |
| v1.13.2 | 2026-02-24 | Fix: badge "Rientro" non mostrato il sabato e la domenica |
| v1.13.1 | 2026-02-24 | Fix: ciclo rientri ogni 42 giorni (6 settimane), aggiunto team 9 |
| v1.13.0 | 2026-02-24 | Step Team nel wizard, rientri in sede indicati nel calendario |
| v1.8.0 | 2026-02-24 | Calendario inline per selezione settimana |
| v1.7.0 | 2026-02-24 | Monte ore 20h/30h/33h/40h settimanali con menu a tendina |
| v1.6.0 | 2026-02-24 | Integrazione Firebase Firestore — sync dati multi-device |
| v1.5.0 | 2026-02-24 | Pannello login admin · ricerca turni per orario specifico |
| v1.4.1 | 2026-02-24 | Fix share/save · redesign topbar |
| v1.4.0 | 2026-02-24 | 10 miglioramenti UX (oggi highlight, print CSS, contatore ore…) |
| v1.3.1 | 2026-02-24 | Export PNG della vista attiva |
| v1.3.0 | 2026-02-24 | Vista calendario mensile · filtri mese · gestione team colleghi |
| v1.0.0 | 2026-02-24 | Release iniziale |


---

## ✨ Funzionalità

- 👤 **Due ruoli** supportati: Dipendente (ciclo 18 settimane) e Tutor (ciclo 15 settimane)
- 📆 **Generazione automatica** fino a fine anno dalla settimana di partenza selezionata
- 🕐 **Monte ore configurabile**: 20h · 30h · 33h · 40h settimanali (menu a tendina)
- 🗓️ **Festività italiane** rilevate automaticamente (Pasquetta inclusa)
- 🌙 **Tema light/dark** commutabile
- 📊 **Vista tabella**, **vista schede** e **vista calendario mensile**
- 📸 **Esportazione PNG** e **condivisione** nativa (Web Share API / Clipboard / download)
- 🔒 **Pannello admin** protetto da password per gestire il team
- 👥 **Gestione team**: aggiungi/modifica/elimina colleghi con il proprio ciclo personalizzato
- 🔍 **Ricerca per data e orario**: chi è in turno in un dato momento?
- ☁️ **Sincronizzazione Firebase Firestore**: dati persistenti su tutti i dispositivi
- 💾 Fallback **localStorage** se Firebase non è disponibile

---

## 🏗️ Struttura del progetto

```
matrice visual/
├── index.html          # Applicazione completa (single file)
├── api/
│   └── auth-config.js  # Serverless function Vercel — espone credenziali Firebase
├── vercel.json         # Configurazione deploy
└── README.md
```

L'intera app è contenuta in un singolo `index.html` — nessuna dipendenza da installare, nessun build step.

---

## 🔐 Admin & Firebase

L'accesso al pannello **Team** (aggiunta/modifica/eliminazione colleghi) è protetto da password admin.

Le credenziali (email Firebase + password) non sono mai nel codice Git: vengono caricate a runtime dall'endpoint `/api/auth-config` che le legge dalle **variabili d'ambiente Vercel** (`FB_EMAIL`, `FB_PASS`).

### Setup variabili Vercel
```
FB_EMAIL = <email utente Firebase Authentication>
FB_PASS  = <password utente Firebase Authentication>
```

### Regole Firestore consigliate
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /userdata/main {
      allow read, write: if request.auth != null;
    }
  }
}
```

---

## 🔄 Pattern turni

### Dipendente — ciclo 18 settimane
Ogni settimana ha un orario di inizio e 2 giorni di riposo fissi. Alcune settimane hanno override specifici per Sabato/Domenica.

### Tutor — ciclo 15 settimane
| # | Orario | Riposi |
|---|--------|--------|
| 1 | 12:00 | Mer, Sab |
| 2 | 06:00 | Mar, Sab |
| 3 | 18:00 | Mer, Dom |
| 4 | 15:00 | Sab, Dom |
| 5 | 06:00 | Gio, Dom |
| 6 | 18:00 | Lun, Sab |
| 7 | 12:00 | Mar, Dom |
| 8 | 08:00 | Sab, Dom |
| 9 | 18:00 | Mar, Sab |
| 10 | 12:00 | Lun, Sab |
| 11 | 06:00 | Mer, Dom |
| 12 | 11:00 | Sab, Dom |
| 13 | 12:00 | Gio, Dom |
| 14 | 06:00 | Lun, Sab |
| 15 | 18:00 | Gio, Dom |

> Il turno `18:00` è speciale: l'orario di inizio viene ricalcolato come `mezzanotte − monte ore`, con fine sempre a `00:00`.

---

## 🚀 Deploy

Il progetto è deployato su **Vercel** con auto-deploy su push al branch `master`.

```bash
git add .
git commit -m "descrizione modifica"
git push
```

---

## 📦 Dipendenze esterne (CDN)
- [Inter Font](https://fonts.google.com/specimen/Inter) — Google Fonts
- [Font Awesome 6.5](https://fontawesome.com/) — icone
- [html2canvas 1.4.1](https://html2canvas.hertzen.com/) — export PNG
- [Firebase 9 compat](https://firebase.google.com/) — Auth + Firestore

---

## 📋 Changelog

| Versione | Data | Note |
|----------|------|------|
| v1.13.2 | 2026-02-24 | Fix: badge "Rientro" non mostrato il sabato e la domenica |
| v1.13.1 | 2026-02-24 | Fix: ciclo rientri ogni 42 giorni (6 settimane), aggiunto team 9 |
| v1.13.0 | 2026-02-24 | Step Team nel wizard, rientri in sede indicati nel calendario |
| v1.8.0 | 2026-02-24 | Calendario inline per selezione settimana — rimossi pulsanti Mese/Settimana disabilitati |
| v1.7.0 | 2026-02-24 | Monte ore 20h/30h/33h/40h settimanali con menu a tendina |
| v1.6.0 | 2026-02-24 | Integrazione Firebase Firestore — sync dati multi-device |
| v1.5.0 | 2026-02-24 | Pannello login admin · ricerca turni per orario specifico |
| v1.4.1 | 2026-02-24 | Fix share/save · redesign topbar |
| v1.4.0 | 2026-02-24 | 10 miglioramenti UX (oggi highlight, print CSS, contatore ore…) |
| v1.3.1 | 2026-02-24 | Export PNG della vista attiva |
| v1.3.0 | 2026-02-24 | Vista calendario mensile · filtri mese · gestione team colleghi |
| v1.0.0 | 2026-02-24 | Release iniziale |


---

## 🏗️ Struttura del progetto

```
matrice visual/
├── index.html          # Applicazione completa (single file)
└── README.md
```

L'intera app è contenuta in un singolo file `index.html` — nessuna dipendenza da installare, nessun build step.

---

## 🔄 Pattern turni

### Dipendente — ciclo 18 settimane
Ogni settimana ha un orario di inizio e 2 giorni di riposo fissi. Alcune settimane hanno override specifici per Sabato/Domenica.

### Tutor — ciclo 15 settimane
| # | Orario | Riposi | Override weekend |
|---|--------|--------|-----------------|
| 1 | 12:00 | Mer, Sab | Dom → 12:00 |
| 2 | 06:00 | Mar, Sab | Dom → 06:00 |
| 3 | 18:00 | Mer, Dom | Sab → 18:00 |
| 4 | 15:00 | Sab, Dom | — |
| 5 | 06:00 | Gio, Dom | Sab → 06:00 |
| 6 | 18:00 | Lun, Sab | Dom → 18:00 |
| 7 | 12:00 | Mar, Dom | Sab → 12:00 |
| 8 | 08:00 | Sab, Dom | — |
| 9 | 18:00 | Mar, Sab | Dom → 18:00 |
| 10 | 12:00 | Lun, Sab | Dom → 12:00 |
| 11 | 06:00 | Mer, Dom | Sab → 06:00 |
| 12 | 11:00 | Sab, Dom | — |
| 13 | 12:00 | Gio, Dom | Sab → 12:00 |
| 14 | 06:00 | Lun, Sab | Dom → 06:00 |
| 15 | 18:00 | Gio, Dom | Sab → 18:00 |

> Il turno `18:00` è speciale: l'orario di inizio viene ricalcolato come `mezzanotte − monte ore`, con fine sempre a `00:00`.

---

## 🚀 Deploy

Il progetto è deployato su **Vercel** con il progetto `amatriciana`.

### Aggiornamento manuale
```bash
git add .
git commit -m "update"
git push
```
Vercel aggiornerà automaticamente la preview e la produzione.

---

## 📦 Dipendenze esterne (CDN)
- [Inter Font](https://fonts.google.com/specimen/Inter) — Google Fonts
- [Font Awesome 6.5](https://fontawesome.com/) — icone
- [html2canvas 1.4.1](https://html2canvas.hertzen.com/) — export PNG

---

## 📝 Changelog
### v1.4.0
- **Fix** export schede PNG: tutti i pannelli ora aperti nel clone
- **Fix** reset: `updateGenerateEnabled()` chiamato correttamente
- **Fix** calendario mobile: celle leggibili su schermi < 480px
- **Tasto Oggi**: scrolla alla cella/riga/giorno corrente nella vista attiva
- **Evidenziazione giorno corrente** in tutte e 3 le viste (azzurro/outline)
- **Contatore ore mensili** nel calendario: `N giorni · Xh Ym` per ogni mese
- **Filtro rapido mese** nel calendario: pill cliccabili per saltare al mese
- **Weekend colorati** nel calendario (Sab/Dom lavorativi con sfondo distinto)
- **Indicatore vista attiva** sotto il tasto Vista (Tabella / Schede / Calendario)
- **CSS Stampa ottimizzato**: stampa solo la vista attiva, no topbar/bottombar
### v1.3.0
- Nuova vista **Calendario mensile**: griglia 7 colonne (Lun-Dom) per ogni mese generato
- Il tasto Vista cicla tra 3 modalità: Tabella → Schede → Calendario → Tabella
- Icona del toggle aggiornata per indicare la prossima vista
- Preferenza di vista salvata in localStorage

### v1.2.0
- Matrice generata fino a fine anno per entrambi i ruoli (Dipendente + Tutor)

### v1.1.0
- Matrice Tutor estesa fino a fine anno dalla settimana di partenza

### v1.0.0
- Prima release: matrice 18 settimane (Dipendente) e 15 settimane (Tutor)
- Tema light/dark, export PNG, condivisione, festività italiane
