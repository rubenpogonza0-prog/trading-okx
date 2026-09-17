# Grid Trading Bot — reglas de decisión y protocolo de ejecución

Este documento define lo que Claude Code **DEBE** hacer cuando el usuario pide
analizar un mercado y desplegar un grid bot (Neutral, Long o Short) en OKX
Futuros (USDT-margined perpetual swaps). El código que implementa estas
reglas vive en `backend/src/grid/` — este archivo y `backend/src/grid/planner.js`
deben mantenerse sincronizados; si cambias un umbral o una fórmula en uno,
actualiza el otro.

No relacionado con esto: `backend/src/trading/` es un bot distinto (scalping
1H/5M autónomo). No lo mezcles con el flujo de grid.

## Comando disparador

Cuando el usuario escriba algo con esta forma:

> "Analiza NEAR/USDT en 1h y despliega el grid correspondiente"
> "Analiza BTC-USDT-SWAP en 4h y lanza el grid"

Claude **DEBE** ejecutar el protocolo completo de la sección "Protocolo de
ejecución" abajo, de inicio a fin, sin pedir confirmación paso a paso (el
usuario ya autorizó el flujo completo al configurar este proyecto). Símbolo y
timeframe son los únicos parámetros que el usuario necesita dar; todo lo
demás (rango, número de grillas, apalancamiento, stop loss) se calcula según
las reglas de este documento.

Excepciones en las que SÍ hay que parar y preguntar antes de operar en real:
- La cuenta no tiene `OKX_DEMO=1` y es la primera vez que se despliega un
  grid en esta cuenta en la sesión — confirmar una vez que el usuario quiere
  operar con dinero real, no en demo.
- El símbolo pedido no existe como `*-USDT-SWAP` en OKX, o no hay suficiente
  historial de velas (< 210 velas) para calcular EMA200 de forma fiable.
- Ya hay 3 o más grids activos rastreados en `backend/data/grid-state.json`
  (límite de exposición simultánea, análogo al bot de scalping).

## Reglas de decisión

Con ADX(14) y EMA200 calculados en el timeframe pedido por el usuario:

1. **ADX < 20** → **GRID NEUTRAL**.
   Rango = Bollinger Bands(20,2): límite inferior = banda inferior, límite
   superior = banda superior, ambas en el timeframe analizado.
2. **20 ≤ ADX < 25** → **GRID NEUTRAL** (regla añadida para cubrir la zona
   gris que ni cumple ADX<20 ni ADX>25: tendencia formándose pero sin fuerza
   suficiente para apostar direccional). Mismo cálculo de rango que el caso 1.
3. **Precio > EMA200 y ADX ≥ 25** → **GRID LONG**.
   Compras escalonadas por debajo del precio actual, take-profit arriba.
4. **Precio < EMA200 y ADX ≥ 25** → **GRID SHORT**.
   Ventas escalonadas por encima del precio actual, take-profit abajo.

## Parámetros obligatorios y cómo se calculan

Todos los valores por defecto están en `backend/src/grid/riskConfig.js`
(overridables por variables de entorno, ver `.env.example`).

- **Rango inferior / superior**:
  - Neutral: banda inferior/superior de Bollinger(20,2).
  - Long: `inferior = precio - 2×ATR(14)`, `superior = precio + 4×ATR(14)`
    (más ancho hacia arriba porque el grid tiene sesgo alcista y debe dejar
    correr la tendencia).
  - Short: `superior = precio + 2×ATR(14)`, `inferior = precio - 4×ATR(14)`
    (simétrico, más ancho hacia abajo).
- **Cantidad de grillas** (basado en ATR): cada celda del grid ocupa
  aproximadamente `0.5×ATR(14)`. `gridNum = round((superior - inferior) /
  (0.5×ATR))`, acotado entre 8 y 50 grillas.
- **Apalancamiento** (máximo 3x, nunca más): escalado por volatilidad —
  `ATR% ≥ 5%` → 1x; `2% ≤ ATR% < 5%` → 2x; si no, 3x. El código además
  fuerza un techo absoluto de 3x sin importar la configuración de entorno.
- **Margen**: `GRID_MARGIN_USDT` (default 20 USDT) por despliegue.
- **Stop Loss estricto**:
  - Long: precio de disparo = `inferior_del_rango - 1.5×ATR(14)` (SL por
    precio, vía `slTriggerPx` en la API de grid de OKX).
  - Short: precio de disparo = `superior_del_rango + 1.5×ATR(14)`.
  - Neutral: SL por ratio (`slRatio`, default 15% del margen) — un grid
    neutral puede romperse hacia cualquier lado, así que el stop es por
    pérdida máxima, no por nivel de precio. `monitor.js` además vigila un
    nivel de ruptura (`banda ± 1.5×ATR`) como alerta temprana.
  - Take-profit direccional: Long liquida el grid completo si el precio
    llega al límite superior del rango; Short si llega al límite inferior.
    Neutral no lleva TP de nivel único (la ganancia viene de las celdas del
    grid operando dentro del rango).

## Protocolo de ejecución

1. **Analizar**: `node backend/src/grid/analyze.js <SYMBOL> <BAR>` — o
   directamente `analyzeAndPlan()` de `backend/src/grid/planner.js`, que ya
   encadena análisis + decisión. Revisar el JSON resultante.
2. **Decidir y calcular parámetros**: aplicar las reglas de arriba (el
   propio `planner.js` ya lo hace — no recalcules a mano, usa su salida como
   fuente de verdad).
3. **Mostrar el plan al usuario** en la respuesta de chat: modo, rango,
   número de grillas, apalancamiento, margen, stop loss, take profit — antes
   de ejecutar, para que quede visible qué se está a punto de desplegar.
4. **Ejecutar**:
   - Preferí las tools MCP `okx` (`grid_create_order`, ya validadas contra
     el esquema actual de la API) para el despliegue interactivo en esta
     sesión de Claude Code — son más confiables que invocar el REST crudo.
     Pasa `simulatedTrading: true` si `OKX_DEMO=1` en `.env`, si no `false`.
   - `backend/src/grid/deploy.js` (`npm run grid:deploy -- <SYMBOL> <BAR>
     --live`) es el módulo equivalente basado en las API keys de entorno
     (`OKX_API_KEY`/`OKX_API_SECRET`/`OKX_API_PASSPHRASE`), pensado para
     ejecución desatendida (GitHub Actions, cron). Usalo si el usuario pide
     explícitamente correr el script del repo en vez de que vos operes
     directo, o para probar el pipeline completo end-to-end.
   - **Nunca** saltear el paso de dry-run (`deploy.js` sin `--live`, o
     `analyzeAndPlan()` solo) la primera vez que se prueba un símbolo nuevo.
5. **Registrar**: todo despliegue queda en `backend/data/grid-state.json`
   (bots activos) y `backend/data/grid-cycles.log` (historial). Si ejecutás
   vía MCP en vez de `deploy.js`, agregá manualmente la entrada a
   `grid-state.json` con `algoId`, `instId`, `mode`, `range`, `gridNum`,
   `leverage`, `stopLoss` — así `monitor.js` y las próximas sesiones lo
   siguen rastreando.
6. **Monitorear** (ver abajo).

## Monitoreo y ajustes continuos

`backend/src/grid/monitor.js` corre cada 15 min vía
`.github/workflows/grid-monitor.yml` (mismo patrón que `trade-cycle.yml`) y
aplica estas reglas por cada bot activo:

- **Stop-loss estricto roto** → cerrar inmediatamente, sin importar la
  ganancia/pérdida flotante. La protección de capital nunca se pospone.
- **Cambio de régimen de mercado** (el modo recomendado ahora difiere del
  modo con el que se desplegó el bot) **y el bot está en ganancia** → cerrar
  para asegurar la ganancia. No se re-despliega automáticamente; el
  siguiente despliegue es una decisión explícita (comando nuevo del usuario,
  o `--redeploy` manual).
- **Cambio de régimen y el bot está en pérdida** → mantener, seguir
  monitoreando. No se cristaliza una pérdida solo por una lectura de
  régimen; el stop-loss estricto sigue siendo la única razón para cerrar en
  pérdida.

Cuando Claude opera de forma interactiva (no vía el workflow) y el usuario
pide "monitorealo", además de confiar en el cron de GitHub Actions, Claude
puede correr `node backend/src/grid/status.js` o `node
backend/src/grid/monitor.js` directamente y reportar el estado, y ejecutar
`monitor.js --adjust` (o las tools MCP `grid_stop_order`/`grid_close_position`)
si detecta que corresponde cerrar según las reglas de arriba.

**Importante — ninguna estrategia garantiza ganancia en cada operación.**
Estas reglas optimizan para salir en ganancia cuando es posible y limitar la
pérdida cuando no lo es (stop loss estricto, apalancamiento máximo 3x,
tamaño de posición fijo). Una ruptura violenta del rango antes de que el
stop-loss se ejecute, slippage, o un evento de mercado extremo pueden
igualmente resultar en pérdida. Comunicá esto al usuario si el contexto lo
amerita — no prometas un resultado que el sistema no puede garantizar.

## Seguridad

- API key de OKX: solo permiso **Trade**, nunca **Withdraw**. `.env` está en
  `.gitignore` — nunca commitear credenciales.
- Probar siempre primero con `OKX_DEMO=1` antes de apuntar a la cuenta real.
- `backend/src/grid/gridClient.js` usa los endpoints REST
  `/api/v5/tradingBot/grid/*` documentados en la API v5 de OKX — si algo
  falla con un error de la API al usar el módulo de ejecución en vez de las
  tools MCP, verificar esos paths contra la documentación oficial vigente
  antes de asumir que es un bug de lógica.
