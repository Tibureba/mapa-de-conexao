// Mapa de Conexão: WebXR (realidade aumentada do Chrome/ARCore) + medições do navegador.
// O navegador não entrega a força do sinal do Wi-Fi (dBm): no lugar, mede a velocidade REAL
// baixando um arquivo de teste deste mesmo endereço.
import * as THREE from 'three';

const $ = (s) => document.querySelector(s);
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ o que dá para mapear
// fracao: 0 = ruim (vermelho) … 1 = bom (verde)
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

function corRGB(f) {
  // do vermelho (0°) ao verde (128°) passando pelo amarelo, como no app
  const c = new THREE.Color();
  c.setHSL((f * 128) / 360, 0.95, 0.55);
  return c;
}
const corCss = (f) => '#' + corRGB(f).getHexString();

// ------------------------------------------------------------------ estado
const estado = {
  modo: 'vel',
  valor: { vel: null, ruido: null, luz: null },
  detalhe: { vel: 'Medindo…', ruido: 'Nível de som aproximado', luz: 'Estimativa da realidade aumentada' },
  amostras: { vel: [], ruido: [], luz: [] }, // {p: Vector3, valor, fracao, em}
  rastreando: false,
};

// ------------------------------------------------------------------ velocidade
// Baixa um arquivo deste mesmo site e mede quanto tempo levou. O tamanho se ajusta para cada teste
// durar uns 300 ms: rápido o bastante para acompanhar quem está andando.
const TAMANHOS = [65536, 262144, 1048576, 4194304];
let indiceTamanho = 1;
let medindoVel = false;
async function medirVelocidade() {
  if (medindoVel) return;
  medindoVel = true;
  try {
    const p0 = performance.now();
    await fetch(`ping.txt?x=${Math.random()}`, { cache: 'no-store' }).then((r) => r.text());
    const latencia = performance.now() - p0;

    const tam = TAMANHOS[indiceTamanho];
    const t0 = performance.now();
    const r = await fetch(`teste-${tam}.bin?x=${Math.random()}`, { cache: 'no-store' });
    const b = await r.arrayBuffer();
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
let microfone = null;
async function ligarMicrofone() {
  if (analisador) return true;
  try {
    microfone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    const fonte = ctx.createMediaStreamSource(microfone);
    analisador = ctx.createAnalyser();
    analisador.fftSize = 2048;
    bufAudio = new Float32Array(analisador.fftSize);
    fonte.connect(analisador);
    return true;
  } catch {
    mensagem('Sem o microfone não dá para medir o ruído. Libere o microfone para esta página.');
    return false;
  }
}
function lerRuido() {
  if (!analisador) return;
  analisador.getFloatTimeDomainData(bufAudio);
  let soma = 0;
  for (const x of bufAudio) soma += x * x;
  const rms = Math.max(Math.sqrt(soma / bufAudio.length), 1e-5);
  // mesma conta do app instalado: dB relativos ao fundo de escala + 96 ≈ nível de som aproximado
  const db = 20 * Math.log10(rms) + 96;
  const antes = estado.valor.ruido;
  estado.valor.ruido = antes == null ? db : antes * 0.85 + db * 0.15;
}

// ------------------------------------------------------------------ claridade
let sondaLuz = null;
function lerLuz(frame) {
  if (!sondaLuz) return;
  const est = frame.getLightEstimate?.(sondaLuz);
  if (!est) return;
  // luz principal + luz ambiente (1º coeficiente harmônico): vira um "quanto está claro" de 0 a 100
  const i = est.primaryLightIntensity;
  const h = est.sphericalHarmonicsCoefficients;
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const total = lum(i.x, i.y, i.z) + (h ? lum(h[0], h[1], h[2]) : 0);
  const pct = limitar((Math.log10(1 + total * 20) / Math.log10(1 + 20 * 3)) * 100, 0, 100);
  const antes = estado.valor.luz;
  estado.valor.luz = antes == null ? pct : antes * 0.8 + pct * 0.2;
}

// ------------------------------------------------------------------ cena 3D
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = 'none';

const cena = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 60);
cena.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4));
const sol = new THREE.DirectionalLight(0xffffff, 1.6);
sol.position.set(-1, 2, 1);
cena.add(sol);

const MAX = 4000;
// bolhas: esferas com brilho, uma malha "instanciada" para desenhar milhares de uma vez
const bolhas = new THREE.InstancedMesh(
  new THREE.SphereGeometry(1, 24, 16),
  new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.88, shininess: 90, specular: 0x777777 }),
  MAX,
);
bolhas.count = 0;
bolhas.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bolhas.frustumCulled = false;
cena.add(bolhas);

const m4 = new THREE.Matrix4();
const q0 = new THREE.Quaternion();
const escala = new THREE.Vector3();
const RAIO = 0.065;

function redesenharBolhas(agora, melhor, pior) {
  const lista = estado.amostras[estado.modo];
  bolhas.count = lista.length;
  lista.forEach((a, i) => {
    const idade = (agora - a.em) / 350;
    const surgir = idade < 1 ? 1 - (1 - idade) * (1 - idade) : 1;
    const destaque = a === melhor || a === pior ? 1.45 : 1;
    escala.setScalar(RAIO * surgir * destaque);
    m4.compose(a.p, q0, escala);
    bolhas.setMatrixAt(i, m4);
    if (!a.pintada) { bolhas.setColorAt(i, corRGB(a.fracao)); a.pintada = true; }
  });
  bolhas.instanceMatrix.needsUpdate = true;
  if (bolhas.instanceColor) bolhas.instanceColor.needsUpdate = true;
}

// ------------------------------------------------------------------ amostragem
const pos = new THREE.Vector3();
const frente = new THREE.Vector3();
const quat = new THREE.Quaternion();
function amostrar(pose) {
  const v = estado.valor[estado.modo];
  if (v == null) return;
  const t = pose.transform;
  pos.set(t.position.x, t.position.y, t.position.z);
  quat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
  frente.set(0, 0, -1).applyQuaternion(quat);
  frente.y = 0;
  if (frente.lengthSq() > 0.04) frente.normalize(); else frente.set(0, 0, 0);
  // um pouco à frente e abaixo do celular, onde a câmera ainda vê (igual ao app)
  const p = pos.clone().addScaledVector(frente, 0.45);
  p.y -= 0.32;
  const lista = estado.amostras[estado.modo];
  if (lista.length >= MAX) return;
  if (lista.some((a) => a.p.distanceToSquared(p) < 0.17 * 0.17)) return;
  const m = MODOS[estado.modo];
  lista.push({ p, valor: v, fracao: m.fracao(v), em: performance.now() });
  // a cor da bolha nova entra na próxima pintura
}

// ------------------------------------------------------------------ tela de cima
function mensagem(t) { $('#msg').textContent = t; }

const etq = (el, a, rotulo) => {
  if (!a) { el.style.display = 'none'; return; }
  const v = a.p.clone().project(renderer.xr.getCamera());
  if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { el.style.display = 'none'; return; }
  const m = MODOS[estado.modo];
  el.textContent = `${rotulo} · ${m.formatar(a.valor)}`;
  el.style.borderColor = corCss(a.fracao);
  el.style.left = `${((v.x + 1) / 2) * window.innerWidth}px`;
  el.style.top = `${((1 - v.y) / 2) * window.innerHeight}px`;
  el.style.display = 'block';
};

let ultimoHud = 0;
function atualizarHud(agora, melhor, pior) {
  etq($('#etqMelhor'), melhor, 'Melhor');
  etq($('#etqPior'), pior, 'Pior');
  if (agora - ultimoHud < 150) return;
  ultimoHud = agora;
  const m = MODOS[estado.modo];
  const v = estado.valor[estado.modo];
  $('#titulo').textContent = m.titulo;
  $('#detalhe').textContent = estado.detalhe[estado.modo];
  if (v == null) {
    $('#valor').innerHTML = '--';
    $('#qualidade').textContent = '';
  } else {
    const cor = corCss(m.fracao(v));
    $('#valor').innerHTML = `<span style="color:${cor}">${m.formatar(v)}</span><small> ${m.unidade}</small>`;
    $('#qualidade').textContent = m.qualidade(v);
    $('#qualidade').style.color = cor;
  }
  const lista = estado.amostras[estado.modo];
  $('#contagem').textContent = lista.length === 0 ? 'Nenhuma medição ainda'
    : `${lista.length} medições` + (melhor ? ` · melhor ${m.formatar(melhor.valor)}` : '') + (pior ? ` · pior ${m.formatar(pior.valor)}` : '');
  if (!estado.rastreando) mensagem('Aponte a câmera para o ambiente e mova o celular devagar até ele reconhecer o lugar.');
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
  if (modo === 'luz' && !sondaLuz) { mensagem('A estimativa de claridade não está disponível neste aparelho.'); return; }
  estado.modo = modo;
  document.querySelectorAll('#seletor button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
  estado.amostras[modo].forEach((a) => { a.pintada = false; });
  pintarLegenda();
  ultimoHud = 0;
}

document.querySelectorAll('#seletor button').forEach((b) => b.addEventListener('click', () => escolherModo(b.dataset.modo)));
$('#limpar').addEventListener('click', () => { estado.amostras[estado.modo] = []; });

// ------------------------------------------------------------------ sessão de RA
let sessao = null;
let espacoRef = null;
let relogioVel = null;

async function comecar() {
  try {
    sessao = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: $('#hud') },
    });
  } catch (e) {
    $('#aviso').textContent = 'Não consegui abrir a realidade aumentada: ' + (e.message || e);
    return;
  }
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(sessao);
  espacoRef = renderer.xr.getReferenceSpace();
  try { sondaLuz = await sessao.requestLightProbe(); } catch { sondaLuz = null; }

  $('#entrada').style.display = 'none';
  $('#hud').classList.add('ativo');
  renderer.domElement.style.display = 'block';
  pintarLegenda();
  medirVelocidade();
  relogioVel = setInterval(() => { if (estado.modo === 'vel' || estado.valor.vel == null) medirVelocidade(); }, 700);

  sessao.addEventListener('end', () => {
    clearInterval(relogioVel);
    renderer.setAnimationLoop(null);
    $('#hud').classList.remove('ativo');
    renderer.domElement.style.display = 'none';
    $('#entrada').style.display = '';
    $('#iniciar').textContent = 'Voltar ao mapa';
    sessao = null;
  });

  renderer.setAnimationLoop((t, frame) => {
    if (!frame) return;
    const agora = performance.now();
    const pose = frame.getViewerPose(espacoRef);
    estado.rastreando = !!pose && !pose.emulatedPosition;
    if (estado.modo === 'ruido') lerRuido();
    if (estado.modo === 'luz') lerLuz(frame);
    if (estado.rastreando) amostrar(pose);
    const lista = estado.amostras[estado.modo];
    let melhor = null, pior = null;
    for (const a of lista) {
      if (!melhor || a.fracao > melhor.fracao) melhor = a;
      if (!pior || a.fracao < pior.fracao) pior = a;
    }
    if (lista.length <= 4 || pior === melhor) pior = null;
    redesenharBolhas(agora, melhor, pior);
    renderer.render(cena, camera);
    atualizarHud(agora, estado.rastreando ? melhor : null, estado.rastreando ? pior : null);
  });
}

$('#sair').addEventListener('click', () => sessao?.end());
$('#iniciar').addEventListener('click', comecar);

// ------------------------------------------------------------------ o aparelho aguenta?
(async () => {
  const botao = $('#iniciar');
  if (!window.isSecureContext) { $('#aviso').textContent = 'Abra esta página por um endereço https.'; botao.textContent = 'Indisponível'; return; }
  const ok = navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  if (!ok) {
    botao.textContent = 'Indisponível neste aparelho';
    $('#aviso').textContent = 'A realidade aumentada no navegador funciona no Chrome do Android, em aparelhos com o "Google Play Services para RA". No iPhone, o Safari ainda não tem esse recurso.';
    return;
  }
  botao.disabled = false;
  botao.textContent = 'Iniciar';
})();

window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));
