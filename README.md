# Air Combat

## Avvio locale

Prerequisito: installa [Node.js](https://nodejs.org/) (versione LTS consigliata).

1. Apri un terminale nella cartella del progetto e installa le dipendenze:

   ```powershell
   npm install
   ```

2. Avvia il gioco:

   ```powershell
   npm start
   ```

   Un solo server serve sia la pagina sia il WebSocket. Il controllo di salute è disponibile su `http://localhost:3000/health`.

3. Apri il browser all'indirizzo [http://localhost:3000](http://localhost:3000).

Il client si collega automaticamente al WebSocket della stessa origine: non sono necessari una seconda porta o un secondo terminale.

## Modalità di gioco

- **Single Player**: affronti `Raven AI`, un avversario controllato dal server.
- **Free-For-All** e **Team Battle**: modalità multiplayer per i giocatori collegati allo stesso server.

## Deploy

Pubblica il progetto su un hosting che esegua applicazioni **Node.js persistenti** (per esempio Render, Railway, Fly.io o un VPS). Non usare un hosting solo statico, perché il gioco richiede il WebSocket del server.

- Comando di installazione: `npm install`
- Comando di avvio: `npm start`
- Porta: lascia che l'hosting imposti la variabile d'ambiente `PORT`; il server la usa automaticamente.

Dopo il deploy, apri l'URL fornito dall'hosting: il browser utilizzerà automaticamente `wss://` in HTTPS e si collegherà al medesimo dominio.

## Arresto

Nel terminale in cui è in esecuzione `npm start`, premi `Ctrl+C` per fermare il server.
