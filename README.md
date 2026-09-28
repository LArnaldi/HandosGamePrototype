# Handos

Carta-Forbice-Sasso 1v1 online, prototipo di Handos.

Gioco statico (HTML, CSS, moduli ES) con connessione peer-to-peer tramite PeerJS. Nessuna build, nessuna dipendenza npm.

## Avvio in locale

I moduli ES non funzionano aprendo il file da `file://`, quindi serve un piccolo server:

```sh
python3 -m http.server 8000
```

Poi apri http://localhost:8000
