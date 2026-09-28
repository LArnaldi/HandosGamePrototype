# Handos

Carta-Forbice-Sasso 1v1 online, prototipo di Handos.

Gioco statico (HTML, CSS, moduli ES) con connessione peer-to-peer tramite PeerJS. Nessuna build, nessuna dipendenza npm.

## Avvio in locale

I moduli ES non funzionano aprendo il file da `file://`, quindi serve un piccolo server:

```sh
python3 -m http.server 8000
```

Poi apri http://localhost:8000

## Come si gioca

1. Premi "Crea partita" e invia il link (o il codice di 5 lettere) al tuo amico.
2. Ognuno sceglie Sasso, Carta o Forbice: le mosse restano in busta chiusa finché entrambi hanno scelto, così nessuno può sbirciare.
3. Ognuno parte con 20 HP. Chi perde il round perde HP in base alla mossa vincente: Sasso toglie 5 HP, Carta 3, Forbice 1. In caso di pareggio entrambi perdono 1 HP.
4. Chi arriva a 0 HP perde. Se entrambi arrivano a 0 nello stesso round, la partita finisce in pareggio. Alla fine potete chiedere la rivincita: si riparte da 20 HP a testa.

## Pubblicare gratis su GitHub Pages

1. Crea un repository **pubblico** su GitHub (per esempio `handos`), senza README.
2. Collega questa cartella e carica il codice:

   ```sh
   git remote add origin https://github.com/USERNAME/REPO.git
   git push -u origin main
   ```

3. Sul repository apri **Settings → Pages**, alla voce "Source" scegli **Deploy from a branch**, poi branch **main** e cartella **/ (root)**, e premi Save.
4. Aspetta circa un minuto e apri https://USERNAME.github.io/REPO/
5. Premi "Crea partita" e invia il link al tuo amico.

Il file `.nojekyll` dice a GitHub Pages di pubblicare i file così come sono. Ogni `git push` successivo aggiorna il sito.

## Limiti noti

- La connessione è peer-to-peer (WebRTC) senza server TURN: su alcune reti restrittive (reti aziendali, alcuni operatori mobili) i due giocatori potrebbero non riuscire a collegarsi.
- Il server pubblico di PeerJS (0.peerjs.com), usato solo per far incontrare i giocatori, ogni tanto può essere irraggiungibile.
- Non c'è riconnessione: se uno dei due chiude la pagina o perde la rete, la partita finisce.
