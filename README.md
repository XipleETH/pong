# Pong Versus 2v2 + 1v1

Webapp de Pong versus para hasta 4 jugadores, con:

- Render en `three.js`.
- Teclado y gamepad.
- Matchmaking online real con `socket.io` (2v2 Ranked y 1v1 Duel).
- Modo local con bots para slots vacios.
- Poderes (`paddle`, `shield`, `boost`, `split`, `weapon`, `heal`, `restore`, `spawnObstacle`).
- Sistema de armas por niveles (1 disparo, disparo grande, 2 disparos, 2 disparos grandes).
- Disparos que destruyen obstaculos y danan paletas por secciones.
- Mapas procedurales estilo roguelike (bioma + mutador por seed).

## Requisitos

- Node.js 20+
- npm 10+

## Ejecutar en desarrollo

```bash
npm install
npm run dev
```

Esto levanta:

- Cliente Vite: `http://localhost:5173`
- Servidor matchmaking: `http://localhost:3001`

## Matchmaking Real (Servidor Autoritativo)

- Cola por bucket (`playlist + region`) con emparejamiento por MMR.
- Ventana de MMR expandible con el tiempo en cola.
- Ready-check antes de iniciar partida.
- Simulacion de partida en servidor (cliente solo envia input).
- Reconexion con token por partida y ventana de gracia.
- Rating Elo persistente por jugador.
- 2 playlists:
  - `ranked`: 2v2 (party size max 2)
  - `duel`: 1v1 (party size max 1)

## Persistencia

Si defines `DATABASE_URL`, el servidor usa Postgres y crea tablas automaticamente:

- `players`
- `matches`
- `match_players`

Si `DATABASE_URL` no existe, usa modo memoria (volatile).

Variables utiles:

- `PORT` (default `3001`)
- `DATABASE_URL` (opcional)
- `DATABASE_SSL=true` para conexiones SSL (opcional)
- `MATCH_SCORE_LIMIT` (default `7`)

## Build de produccion

```bash
npm run build
npm run start
```

El servidor servira `dist/` si existe y mantendra sockets/matchmaking.
