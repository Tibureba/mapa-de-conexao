// Versão iPhone: o Safari não tem WebXR de realidade aumentada, então o rastreamento do ambiente
// vem do motor do 8th Wall (visão computacional na própria página). As medições são as mesmas
// da versão Android: velocidade real da conexão, ruído e claridade.
// endereço completo, sem "importmap": o Safari só entende importmap do iOS 16.4 em diante
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

window.THREE = THREE; // o módulo three.js do 8th Wall procura o THREE global

const $ = (s) => document.querySelector(s);
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ o que dá para mapear
const MODOS = {
  vel: {
    titulo: 'Velocidade da conexão', unidade: 'Mbps', esq: 'Lenta  1', dir: '100+  Rápida',
    fracao: (v) => limitar(Math.log10(Math.max(v, 0.1)) / 2, 0, 1),
    qualidade: (v) => v >= 50 ? 'Excelente' : v >= 20 ? 'Boa' : v >= 8 ? 'Regular' : v >= 2 ? 'Lenta' : 'Muito lenta',
    formatar: (v) => v >= 10 ? v.toFixed(0) : v.toFixed(1),
    dica: 'Cada bolha é a velocidade medida naquele ponto.',
  },
  ruido: {
    titulo: 'Microfone', unidade: 'dB', esq: 'Barulhento  85', dir: '35  Silêncio',
    fracao: (v) => limitar(1 - (v - 35) / 50, 0, 1),
    qualidade: (v) => v < 40 ? 'Silencioso' : v < 55 ? 'Tranquilo' : v < 65 ? 'Conversa' : v < 75 ? 'Barulhento' : 'Muito barulhento',
    formatar: (v) => v.toFixed(0),
    dica: 'Cada bolha é o barulho naquele ponto. Fique uns segundos em cada lugar.',
  },
  luz: {
    titulo: 'Claridade (estimada pela câmera)', unidade: '%', esq: 'Escuro  0', dir: '100  Claro',
    fracao: (v) => limitar(v / 100, 0, 1),
    qualidade: (v) => v < 20 ? 'Escuro' : v < 40 ? 'Pouca luz' : v < 60 ? 'Ambiente' : v < 80 ? 'Bem iluminado' : 'Muito claro',
    formatar: (v) => v.toFixed(0),
    dica: 'Cada bolha é a claridade que a câmera vê naquele ponto.',
  },
};

function corRGB(f) { const c = new THREE.Color(); c.setHSL((f * 128) / 360, 0.95, 0.55); return c; }
const corCss = (f) => '#' + corRGB(f).getHexString();

const estado = {
  modo: 'vel',
  valor: { vel: null, ruido: null, luz: null },
  detalhe: { vel: 'Medindo…', ruido: 'Nível de som aproximado', luz: 'Estimativa da câmera' },
  amostras: { vel: [], ruido: [], luz: [] },
  rastreando: false,
};

// ------------------------------------------------------------------ velocidade (arquivos da pasta de cima)
const TAMANHOS = [65536, 262144, 1048576, 4194304];
let indiceTamanho = 1;
let medindoVel = false;
async function medirVelocidade() {
  if (medindoVel) return;
  medindoVel = true;
  try {
    const p0 = performance.now();
    await fetch(`../ping.txt?x=${Math.random()}`, { cache: 'no-store' }).then((r) => r.text());
    const latencia = performance.now() - p0;
    const tam = TAMANHOS[indiceTamanho];
    const t0 = performance.now();
    const b = await (await fetch(`../teste-${tam}.bin?x=${Math.random()}`, { cache: 'no-store' })).arrayBuffer();
    const s = (performance.now() - t0) / 1000;
    const mbps = (b.byteLength * 8) / s / 1e6;
    if (s < 0.2 && indiceTamanho < TAMANHOS.length - 1) indiceTamanho++;
    else if (s > 1.0 && indiceTamanho > 0) indiceTamanho--;
    const antes = estado.valor.vel;
    estado.valor.vel = antes == null ? mbps : antes * 0.4 + mbps * 0.6;
    estado.detalhe.vel = `Resposta em ${latencia.toFixed(0)} ms`;
  } catch {
    estado.valor.vel = null;
    estado.detalhe.vel = 'Sem conexão neste ponto';
  } finally {
    medindoVel = false;
  }
}

// ------------------------------------------------------------------ ruído
let analisador = null;
let bufAudio = null;
async function ligarMicrofone() {
  if (analisador) return true;
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    analisador = ctx.createAnalyser();
    analisador.fftSize = 2048;
    bufAudio = new Float32Array(analisador.fftSize);
    ctx.createMediaStreamSource(mic).connect(analisador);
    return true;
  } catch {
    mensagem('Sem o microfone não dá para medir o ruído. Libere o microfone para o Safari.');
    return false;
  }
}
function lerRuido() {
  if (!analisador) return;
  analisador.getFloatTimeDomainData(bufAudio);
  let soma = 0;
  for (const x of bufAudio) soma += x * x;
  const db = 20 * Math.log10(Math.max(Math.sqrt(soma / bufAudio.length), 1e-5)) + 96;
  const antes = estado.valor.ruido;
  estado.valor.ruido = antes == null ? db : antes * 0.85 + db * 0.15;
}

// ------------------------------------------------------------------ claridade: exposição que o motor estima
function lerLuz(realidade) {
  const exp = realidade?.lighting?.exposure;
  if (typeof exp !== 'number') return;
  // a exposição vem mais ou menos entre -1 (escuro) e 1 (claro)
  const pct = limitar((exp + 1) * 50, 0, 100);
  const antes = estado.valor.luz;
  estado.valor.luz = antes == null ? pct : antes * 0.8 + pct * 0.2;
}

// ------------------------------------------------------------------ bolhas
const MAX = 4000;
const RAIO = 0.065;
let bolhas = null;
const m4 = new THREE.Matrix4();
const q0 = new THREE.Quaternion();
const escala = new THREE.Vector3();

function criarBolhas(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4));
  const sol = new THREE.DirectionalLight(0xffffff, 1.6);
  sol.position.set(-1, 2, 1);
  scene.add(sol);
  bolhas = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.88, shininess: 90, specular: 0x777777 }),
    MAX,
  );
  bolhas.count = 0;
  bolhas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bolhas.frustumCulled = false;
  scene.add(bolhas);
}

function redesenhar(agora, melhor, pior) {
  const lista = estado.amostras[estado.modo];
  bolhas.count = lista.length;
  lista.forEach((a, i) => {
    const idade = (agora - a.em) / 350;
    const surgir = idade < 1 ? 1 - (1 - idade) * (1 - idade) : 1;
    escala.setScalar(RAIO * surgir * (a === melhor || a === pior ? 1.45 : 1));
    m4.compose(a.p, q0, escala);
    bolhas.setMatrixAt(i, m4);
    if (!a.pintada) { bolhas.setColorAt(i, corRGB(a.fracao)); a.pintada = true; }
  });
  bolhas.instanceMatrix.needsUpdate = true;
  if (bolhas.instanceColor) bolhas.instanceColor.needsUpdate = true;
}

const frente = new THREE.Vector3();
function amostrar(camera) {
  const v = estado.valor[estado.modo];
  if (v == null) return;
  frente.set(0, 0, -1).applyQuaternion(camera.quaternion);
  frente.y = 0;
  if (frente.lengthSq() > 0.04) frente.normalize(); else frente.set(0, 0, 0);
  const p = camera.position.clone().addScaledVector(frente, 0.45);
  p.y -= 0.32;
  const lista = estado.amostras[estado.modo];
  if (lista.length >= MAX || lista.some((a) => a.p.distanceToSquared(p) < 0.17 * 0.17)) return;
  lista.push({ p, valor: v, fracao: MODOS[estado.modo].fracao(v), em: performance.now() });
}

// ------------------------------------------------------------------ tela de cima
function mensagem(t) { $('#msg').textContent = t; }

function etiqueta(el, a, rotulo, camera) {
  if (!a) { el.style.display = 'none'; return; }
  const v = a.p.clone().project(camera);
  if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { el.style.display = 'none'; return; }
  el.textContent = `${rotulo} · ${MODOS[estado.modo].formatar(a.valor)}`;
  el.style.borderColor = corCss(a.fracao);
  el.style.left = `${((v.x + 1) / 2) * window.innerWidth}px`;
  el.style.top = `${((1 - v.y) / 2) * window.innerHeight}px`;
  el.style.display = 'block';
}

let ultimoHud = 0;
function atualizarHud(agora, melhor, pior, camera) {
  etiqueta($('#etqMelhor'), estado.rastreando ? melhor : null, 'Melhor', camera);
  etiqueta($('#etqPior'), estado.rastreando ? pior : null, 'Pior', camera);
  if (agora - ultimoHud < 150) return;
  ultimoHud = agora;
  const m = MODOS[estado.modo];
  const v = estado.valor[estado.modo];
  $('#titulo').textContent = m.titulo;
  $('#detalhe').textContent = estado.detalhe[estado.modo];
  if (v == null) { $('#valor').innerHTML = '--'; $('#qualidade').textContent = ''; }
  else {
    const cor = corCss(m.fracao(v));
    $('#valor').innerHTML = `<span style="color:${cor}">${m.formatar(v)}</span><small> ${m.unidade}</small>`;
    $('#qualidade').textContent = m.qualidade(v);
    $('#qualidade').style.color = cor;
  }
  const lista = estado.amostras[estado.modo];
  $('#contagem').textContent = lista.length === 0 ? 'Nenhuma medição ainda'
    : `${lista.length} medições` + (melhor ? ` · melhor ${m.formatar(melhor.valor)}` : '') + (pior ? ` · pior ${m.formatar(pior.valor)}` : '');
  if (!estado.rastreando) mensagem('Aponte a câmera para o chão e mova o celular devagar de um lado para o outro até ele reconhecer o lugar.');
  else if (lista.length === 0) mensagem(`Ande devagar com a câmera para frente. ${m.dica}`);
  else mensagem('');
}

function pintarLegenda() {
  const m = MODOS[estado.modo];
  $('#legenda').style.background = `linear-gradient(90deg, ${[0, .2, .4, .6, .8, 1].map(corCss).join(',')})`;
  $('#legEsq').textContent = m.esq;
  $('#legDir').textContent = m.dir;
}

async function escolherModo(modo) {
  if (modo === 'ruido' && !(await ligarMicrofone())) return;
  estado.modo = modo;
  document.querySelectorAll('#seletor button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
  estado.amostras[modo].forEach((a) => { a.pintada = false; });
  pintarLegenda();
  ultimoHud = 0;
}
document.querySelectorAll('#seletor button').forEach((b) => b.addEventListener('click', () => escolherModo(b.dataset.modo)));
$('#limpar').addEventListener('click', () => { estado.amostras[estado.modo] = []; });

// ------------------------------------------------------------------ módulo do 8th Wall com o nosso mapa
function moduloMapa() {
  let camera = null;
  return {
    name: 'mapa-de-conexao',
    onStart: ({ canvas }) => {
      const xr = XR8.Threejs.xrScene();
      camera = xr.camera;
      criarBolhas(xr.scene);
      // altura inicial ~ a de um celular na mão: as distâncias ficam perto de metros
      camera.position.set(0, 1.4, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
      canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
      $('#hud').classList.add('ativo');
      pintarLegenda();
    },
    onUpdate: ({ processCpuResult }) => {
      if (!camera) return;
      const agora = performance.now();
      if (estado.modo === 'ruido') lerRuido();
      if (estado.modo === 'luz') lerLuz(processCpuResult?.reality);
      if (estado.rastreando) amostrar(camera);
      const lista = estado.amostras[estado.modo];
      let melhor = null, pior = null;
      for (const a of lista) {
        if (!melhor || a.fracao > melhor.fracao) melhor = a;
        if (!pior || a.fracao < pior.fracao) pior = a;
      }
      if (lista.length <= 4 || pior === melhor) pior = null;
      redesenhar(agora, melhor, pior);
      atualizarHud(agora, melhor, pior, camera);
    },
    listeners: [
      { event: 'reality.trackingstatus', process: ({ detail }) => { estado.rastreando = detail.status === 'NORMAL'; } },
    ],
  };
}

function rodar() {
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),   // a imagem da câmera
    XR8.Threejs.pipelineModule(),             // a cena three.js
    XR8.XrController.pipelineModule(),        // o rastreamento do ambiente (SLAM)
    LandingPage.pipelineModule(),             // aviso para navegador sem suporte
    XRExtras.FullWindowCanvas.pipelineModule(),
    XRExtras.Loading.pipelineModule(),        // tela de carregamento e pedido de permissões
    XRExtras.RuntimeError.pipelineModule(),
    moduloMapa(),
  ]);
  XR8.run({ canvas: $('#camerafeed') });
  medirVelocidade();
  setInterval(() => { if (estado.modo === 'vel' || estado.valor.vel == null) medirVelocidade(); }, 700);
}

// o Safari só libera câmera e sensores depois de um toque: por isso a tela de entrada
$('#iniciar').addEventListener('click', () => {
  if (window.XR8) { $('#entrada').style.display = 'none'; rodar(); return; }
  // o motor (1 MB) ainda está baixando: avisa e começa sozinho quando chegar
  $('#iniciar').textContent = 'Carregando o motor de realidade aumentada…';
  $('#iniciar').disabled = true;
  window.addEventListener('xrloaded', () => { $('#entrada').style.display = 'none'; rodar(); }, { once: true });
});
window.__mapaPronto = true;
