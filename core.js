// ===== Núcleo: protocolo da Ui16, conversões, análise e motor de sugestões =====
// (sem dependência de DOM: testável no Node)

const Core = (() => {
  // ---------- Conversões (mesmas fórmulas da biblioteca soundcraft-ui-connection) ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r10 = v => Math.round(v * 1e10) / 1e10;
  const EQ_FMAX = 22050, Q_MIN = 0.05, Q_MAX = 15;

  const freqToNorm = f => r10(Math.log(clamp(f, 20, EQ_FMAX) / 20) / Math.log(EQ_FMAX / 20));
  const normToFreq = v => Math.round(20 * Math.pow(EQ_FMAX / 20, clamp(v, 0, 1)));
  const qToNorm = q => r10(Math.log(clamp(q, Q_MIN, Q_MAX) / Q_MIN) / Math.log(Q_MAX / Q_MIN));
  const normToQ = v => Math.round(Q_MIN * Math.pow(Q_MAX / Q_MIN, clamp(v, 0, 1)) * 100) / 100;
  const eqGainToNorm = db => clamp((db + 20) / 40, 0, 1);
  const normToEqGain = v => clamp(Math.round((v * 40 - 20) * 10) / 10, -20, 20);
  const inGainToNorm = db => clamp((db + 40) / 90, 0, 1);      // Ui12/Ui16: -40..+50 dB
  const normToInGain = v => clamp(Math.round((v * 90 - 40) * 10) / 10, -40, 50);
  const vuToDb = v => clamp(Math.round((v * 80 - 80) * 10) / 10, -80, 0);
  const HPF_SLOPES = [12, 24, 36];

  // ---------- Mensagens da mesa ----------
  // A mesa envia linhas "3:::SETD^caminho^valor", "3:::SETS^caminho^texto" e "3:::VU2^base64"
  function parseLines(raw) {
    let d = String(raw);
    if (d.startsWith('3:::')) d = d.slice(4); else if (/^\d:/.test(d)) return [];
    return d.split('\n').filter(Boolean);
  }
  function parseLine(line) {
    if (line.startsWith('SETD^') || line.startsWith('SETS^')) {
      const i = line.indexOf('^', 5);
      if (i < 0) return null;
      const path = line.slice(5, i), val = line.slice(i + 1);
      return { kind: 'set', path, value: line[3] === 'D' ? Number(val) : val };
    }
    if (line.startsWith('VU2^')) return { kind: 'vu', data: line.slice(4) };
    return { kind: 'other', line };
  }
  function decodeVu(b64, atobFn) {
    const s = (atobFn || atob)(b64);
    const e = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) e[i] = s.charCodeAt(i);
    const blocks = [['input', 6], ['player', 6], ['sub', 7], ['fx', 7], ['aux', 5], ['master', 5], ['line', 6]];
    const out = {}; const r = 0.004167508166392142; let i = 8;
    blocks.forEach(([k, size], idx) => {
      out[k] = [];
      for (let n = 0; n < (e[idx] || 0); n++) {
        out[k].push({ pre: e[i] * r, post: e[i + 1] * r, fader: e[i + 2] * r });
        i += size;
      }
    });
    return out;
  }
  const cmd = {
    setd: (p, v) => `3:::SETD^${p}^${v}`,
    alive: () => '3:::ALIVE',
  };
  // canais: 1..12 = entradas (i.0..i.11); 13 e 14 = LINE IN L/R (l.0, l.1)
  const NIN = 12, LINE_L = 13, LINE_R = 14;
  const isLine = n => n >= LINE_L;
  const cid = n => (isLine(n) ? `l.${n - LINE_L}` : `i.${n - 1}`);
  const P = {
    ch: cid,
    band: (n, b, prm) => `${cid(n)}.eq.b${b}.${prm}`,
    hpf: (n, prm) => `${cid(n)}.eq.hpf.${prm}`,
    bypass: n => `${cid(n)}.eq.bypass`,
    gain: n => (isLine(n) ? null : `${cid(n)}.gain`),   // a LINE IN não tem ganho remoto
    name: n => `${cid(n)}.name`,
    stereo: n => `${cid(n)}.stereoIndex`,
    solo: n => `${cid(n)}.solo`,
  };
  const defaultName = n => (n === LINE_L ? 'LINE L' : n === LINE_R ? 'LINE R' : `CH ${n}`);

  // Lê do estado bruto da mesa o EQ de um canal em unidades reais
  function readChannel(state, n) {
    const g = (p, d) => (state[p] === undefined ? d : state[p]);
    const bands = [1, 2, 3, 4].map(b => ({
      band: b,
      freq: normToFreq(g(P.band(n, b, 'freq'), freqToNorm([100, 500, 2000, 8000][b - 1]))),
      gain: normToEqGain(g(P.band(n, b, 'gain'), 0.5)),
      q: normToQ(g(P.band(n, b, 'q'), qToNorm(1))),
    }));
    return {
      n,
      name: g(P.name(n), '') || defaultName(n),
      line: isLine(n),
      bypass: !!g(P.bypass(n), 0),
      hpf: { freq: normToFreq(g(P.hpf(n, 'freq'), 0)), slope: HPF_SLOPES[clamp(Math.round(g(P.hpf(n, 'slope'), 0)), 0, 2)] },
      bands,
      gainDb: !P.gain(n) || state[P.gain(n)] === undefined ? null : normToInGain(state[P.gain(n)]),
      stereoIndex: g(P.stereo(n), -1),
    };
  }
  function linkedChannels(state, n) {
    const si = state[P.stereo(n)];
    if (isLine(n) && (si === undefined || si === -1)) return [n, n === LINE_L ? LINE_R : LINE_L]; // LINE IN é estéreo
    if (si === 0) return [n, n + 1];
    if (si === 1) return [n, n - 1];
    return [n];
  }

  // ---------- Resposta do EQ (para desenhar a curva) ----------
  function peakingDb(f, f0, gainDb, q, fs = 48000) {
    if (Math.abs(gainDb) < 0.01) return 0;
    const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * q), c = Math.cos(w0);
    const b0 = 1 + al * A, b1 = -2 * c, b2 = 1 - al * A, a0 = 1 + al / A, a1 = -2 * c, a2 = 1 - al / A;
    const w = 2 * Math.PI * f / fs, cw = Math.cos(w), c2 = Math.cos(2 * w), sw = Math.sin(w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2);
    const dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  function hpfDb(f, fc, slope) {
    if (fc <= 21) return 0;
    const n = slope / 6;
    return -10 * Math.log10(1 + Math.pow(fc / f, 2 * n));
  }
  function eqResponse(ch, f) {
    if (!ch) return 0;
    let db = hpfDb(f, ch.hpf.freq, ch.hpf.slope);
    if (!ch.bypass) ch.bands.forEach(b => { db += peakingDb(f, b.freq, b.gain, b.q); });
    return db;
  }

  // ---------- Bandas de 1/3 de oitava ----------
  const THIRD = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
    2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];
  function thirdOctave(powerBins, sampleRate, fftSize) {
    // powerBins: potência linear por bin (média no tempo)
    const binHz = sampleRate / fftSize;
    return THIRD.map(fc => {
      const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
      let s = 0, n = 0;
      for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(powerBins.length - 1, Math.ceil(hi / binHz)); k++) {
        const f = k * binHz; if (f < lo || f > hi) continue; s += powerBins[k]; n++;
      }
      if (!n) { const k = Math.round(fc / binHz); s = powerBins[clamp(k, 1, powerBins.length - 1)]; }
      return 10 * Math.log10(s + 1e-20);
    });
  }

  // ---------- Perfis por fonte ----------
  // alvo: pontos (Hz, dB relativo) de um equilíbrio tonal "bom" medido na plateia
  const LTASS = [[63, -24], [100, -12], [160, -3], [250, 0], [500, 0], [1000, -4], [2000, -7], [4000, -9], [6300, -12], [10000, -17], [16000, -26]];
  const Z = (nome, lo, hi, tipo, ouve) => ({ nome, lo, hi, tipo, ouve });
  const PROFILES = {
    pregacao: {
      nome: 'Pregação / voz falada', hpf: 110, core: [250, 4000], alvo: LTASS,
      zonas: [Z('Ronco / proximidade', 90, 180, 'corte', 'voz grave demais, "ronco" quando o pregador chega perto do microfone'),
        Z('Embolado', 200, 450, 'corte', 'voz abafada, sem definição, cansativa'),
        Z('Som de caixa / nasal', 500, 1250, 'corte', 'voz "de telefone", fanha ou de dentro de uma caixa'),
        Z('Aspereza', 2000, 4500, 'corte', 'voz estridente, que "fura" o ouvido'),
        Z('Presença / inteligibilidade', 2000, 5000, 'reforço', 'palavras pouco claras, consoantes somem'),
        Z('Sibilância', 5500, 9000, 'corte', '"S" e "X" chiando')],
    },
    vozFem: {
      nome: 'Voz feminina (canto)', hpf: 150, core: [300, 5000],
      alvo: [[100, -22], [160, -10], [250, -3], [400, 0], [800, -1], [1600, -4], [3150, -6], [5000, -9], [8000, -13], [12500, -18], [16000, -24]],
      zonas: [Z('Embolado', 200, 450, 'corte', 'voz abafada, mistura com os instrumentos'),
        Z('Som de caixa / nasal', 600, 1250, 'corte', 'voz fanha, "de telefone"'),
        Z('Aspereza', 2000, 5000, 'corte', 'agudos que machucam nas notas altas'),
        Z('Presença', 2500, 5000, 'reforço', 'voz escondida atrás da banda'),
        Z('Sibilância', 6300, 10000, 'corte', '"S" chiando'),
        Z('Ar / brilho', 10000, 16000, 'reforço', 'voz sem brilho')],
    },
    vozMasc: {
      nome: 'Voz masculina (canto)', hpf: 100, core: [200, 4000],
      alvo: [[63, -24], [100, -10], [160, -2], [250, 0], [500, 0], [1000, -3], [2000, -6], [4000, -9], [6300, -12], [10000, -17], [16000, -25]],
      zonas: [Z('Ronco / proximidade', 90, 180, 'corte', 'grave excessivo, embola o som'),
        Z('Embolado', 200, 450, 'corte', 'voz abafada, sem definição'),
        Z('Som de caixa / nasal', 500, 1250, 'corte', 'voz fanha, "de telefone"'),
        Z('Aspereza', 2000, 4500, 'corte', 'voz estridente'),
        Z('Presença', 2000, 5000, 'reforço', 'voz escondida atrás da banda'),
        Z('Sibilância', 5500, 9000, 'corte', '"S" chiando')],
    },
    coro: {
      nome: 'Backing vocal / coral', hpf: 160, core: [300, 4000],
      alvo: [[100, -24], [160, -10], [250, -3], [400, 0], [800, -1], [1600, -4], [3150, -7], [5000, -10], [8000, -14], [12500, -19], [16000, -25]],
      zonas: [Z('Embolado', 200, 500, 'corte', 'vozes embolando com a voz principal'),
        Z('Som de caixa / nasal', 600, 1250, 'corte', 'som fanho'),
        Z('Aspereza', 2000, 5000, 'corte', 'vozes estridentes'),
        Z('Sibilância', 6300, 10000, 'corte', '"S" chiando')],
    },
    violao: {
      nome: 'Violão', hpf: 90, core: [150, 6300],
      alvo: [[63, -20], [100, -8], [160, -2], [250, 0], [500, -1], [1000, -3], [2000, -5], [4000, -7], [6300, -9], [10000, -13], [16000, -20]],
      zonas: [Z('Ronco do corpo', 90, 200, 'corte', 'violão "boom", grave que embola'),
        Z('Embolado', 200, 400, 'corte', 'som abafado'),
        Z('Som de captador ("pato")', 700, 1600, 'corte', 'som duro, de plástico, típico de captador piezo'),
        Z('Brilho / ataque', 2500, 5000, 'reforço', 'violão sem definição das cordas'),
        Z('Aspereza', 2500, 5000, 'corte', 'cordas estridentes'),
        Z('Ar', 8000, 14000, 'reforço', 'falta de brilho')],
    },
    teclado: {
      nome: 'Teclado / piano', hpf: 40, core: [100, 6300],
      alvo: [[40, -12], [63, -4], [100, -1], [250, 0], [500, -1], [1000, -3], [2000, -5], [4000, -7], [8000, -11], [16000, -18]],
      zonas: [Z('Embolado', 200, 450, 'corte', 'teclado embolando com o baixo e as vozes'),
        Z('Médio "buzina"', 700, 1600, 'corte', 'som anasalado'),
        Z('Aspereza', 2000, 5000, 'corte', 'piano/synth estridente')],
    },
    baixo: {
      nome: 'Contrabaixo', hpf: 35, core: [50, 1000],
      alvo: [[31.5, -10], [50, -2], [80, 0], [125, 0], [250, -3], [500, -7], [1000, -11], [2000, -15], [4000, -20], [8000, -28]],
      zonas: [Z('Sobra de grave', 50, 125, 'corte', 'grave que domina a igreja / faz o chão vibrar'),
        Z('Embolado', 180, 400, 'corte', 'baixo sem definição das notas'),
        Z('Definição / ataque', 700, 1600, 'reforço', 'não dá para ouvir as notas do baixo')],
    },
    bumbo: {
      nome: 'Bumbo', hpf: 35, core: [50, 5000],
      alvo: [[31.5, -10], [50, -1], [63, 0], [100, -1], [250, -8], [500, -12], [1000, -12], [2500, -10], [5000, -14], [10000, -22]],
      zonas: [Z('Som de caixa de papelão', 250, 600, 'corte', 'bumbo "oco", sem pegada'),
        Z('Ataque do batedor', 2000, 5000, 'reforço', 'bumbo sem ataque, só "bum"')],
    },
    caixa: {
      nome: 'Caixa (bateria)', hpf: 90, core: [150, 6300],
      alvo: [[63, -18], [100, -6], [200, 0], [400, -2], [800, -4], [1600, -5], [3150, -5], [6300, -9], [10000, -14], [16000, -22]],
      zonas: [Z('Ronco', 100, 180, 'corte', 'caixa pesada demais'),
        Z('"Anel" da pele', 400, 1000, 'corte', 'caixa com som de lata / ressonância metálica'),
        Z('Estalo', 2000, 5000, 'reforço', 'caixa sem estalo')],
    },
    pratos: {
      nome: 'Pratos / overhead', hpf: 250, core: [500, 12500],
      alvo: [[160, -20], [250, -8], [500, -2], [1000, 0], [2000, -1], [4000, -2], [8000, -4], [12500, -7], [16000, -11]],
      zonas: [Z('Embolado', 250, 500, 'corte', 'sujeira de bumbo e caixa'),
        Z('Aspereza', 2000, 5000, 'corte', 'pratos que machucam o ouvido')],
    },
    guitarra: {
      nome: 'Guitarra', hpf: 90, core: [150, 5000],
      alvo: [[63, -22], [100, -8], [200, -1], [400, 0], [800, 0], [1600, -2], [3150, -5], [5000, -9], [8000, -18], [16000, -30]],
      zonas: [Z('Embolado', 200, 400, 'corte', 'guitarra embolando com voz e teclado'),
        Z('Aspereza', 2000, 4500, 'corte', 'guitarra estridente'),
        Z('Chiado / fritura', 5000, 9000, 'corte', 'distorção chiando')],
    },
    playback: {
      nome: 'Playback / música (LINE)', hpf: 35, core: [100, 8000],
      alvo: [[31.5, -6], [63, 0], [125, 0], [250, -1], [500, -3], [1000, -5], [2000, -7], [4000, -9], [8000, -12], [16000, -18]],
      zonas: [Z('Sobra de grave', 50, 125, 'corte', 'grave do playback embolando a igreja / brigando com o baixo da banda'),
        Z('Embolado', 200, 400, 'corte', 'música abafada'),
        Z('Aspereza', 2000, 5000, 'corte', 'som estridente, típico de MP3 ou vídeo do YouTube'),
        Z('Chiado', 8000, 14000, 'corte', 'chiado / agudo metálico')],
    },
    sopro: {
      nome: 'Sopro (sax, trompete, flauta)', hpf: 120, core: [250, 6300],
      alvo: [[100, -18], [160, -6], [250, -1], [500, 0], [1000, -1], [2000, -3], [4000, -6], [8000, -11], [16000, -22]],
      zonas: [Z('Embolado', 200, 450, 'corte', 'som abafado'),
        Z('Aspereza', 2000, 4500, 'corte', 'som estridente nas notas altas')],
    },
  };
  const NAME_HINTS = [
    [/LINE|PLAY|\bPB\b|NOTE|CELULAR|\bCEL\b|\bPC\b|VIDEO|MIDIA|MÍDIA|MUSICA|MÚSICA/, 'playback'],
    [/PAST|PREG|PALAV|LOCU|LOC\b|PULP|PULPIT|FALA|MC\b/, 'pregacao'],
    [/BACK|CORO|CORAL|BV/, 'coro'],
    [/VIOL[AÃ]O|VLAO|VIOL\b|AC\s*GTR|ACOUS|NYLON/, 'violao'],
    [/BAIXO|BASS|CONTRA|BX\b/, 'baixo'],
    [/BUMB|KICK|BD\b/, 'bumbo'],
    [/CAIXA|SNARE|SN\b|CX\b/, 'caixa'],
    [/OH|OVER|PRAT|HAT|CYM/, 'pratos'],
    [/TECL|KEY|PIANO|SYNTH|ORG[AÃ]O|KB/, 'teclado'],
    [/GUIT|GTR|GUITAR/, 'guitarra'],
    [/SAX|TROMP|FLAUT|SOPRO|TPT|TROMB/, 'sopro'],
    [/MINIST|MULHER|CANTORA|FEM|IRM[AÃ]/, 'vozFem'],
    [/VOZ|VOC|MIC|CANT|LEAD/, 'vozMasc'],
  ];
  function guessProfile(name) {
    const n = String(name || '').toUpperCase();
    for (const [re, p] of NAME_HINTS) if (re.test(n)) return p;
    return null;
  }

  function interpTarget(points, f) {
    const lf = Math.log2(f);
    if (f <= points[0][0]) return points[0][1] - 12 * (Math.log2(points[0][0]) - lf);
    for (let i = 1; i < points.length; i++) {
      if (f <= points[i][0]) {
        const [f0, d0] = points[i - 1], [f1, d1] = points[i];
        const t = (lf - Math.log2(f0)) / (Math.log2(f1) - Math.log2(f0));
        return d0 + t * (d1 - d0);
      }
    }
    const [fl, dl] = points[points.length - 1];
    return dl - 8 * (lf - Math.log2(fl));
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Desvio por banda em relação ao alvo (alinhado pela faixa principal do perfil)
  function deviations(bandsDb, profile) {
    const tgt = THIRD.map(f => interpTarget(profile.alvo, f));
    const idx = THIRD.map((f, i) => i).filter(i => THIRD[i] >= profile.core[0] && THIRD[i] <= profile.core[1]);
    const off = median(idx.map(i => bandsDb[i] - tgt[i]));
    return { dev: bandsDb.map((v, i) => v - tgt[i] - off), target: tgt.map(t => t + off) };
  }

  const fmtHz = f => (f >= 1000 ? (Math.round(f / 100) / 10).toString().replace('.', ',') + ' kHz' : Math.round(f) + ' Hz');
  const roundHz = f => (f < 100 ? Math.round(f) : f < 1000 ? Math.round(f / 5) * 5 : Math.round(f / 50) * 50);

  // ---------- Motor de sugestões ----------
  // análise: { bands:[29 dB], rings:[{freq, prom}], peakPreDb (opcional) }
  // canal: resultado de readChannel (ou null sem mesa)
  function suggest(analysis, profileKey, canal, opts = {}) {
    const prof = PROFILES[profileKey];
    const out = [];
    const thr = opts.limiar || 4.5;
    const { dev } = deviations(analysis.bands, prof);
    const lowMic = opts.micLowCut || 80; // celular/tablet capta mal abaixo disso

    // 1) Filtro passa-altas
    if (prof.hpf > 30) {
      const atual = canal ? canal.hpf.freq : null;
      if (atual === null || atual < prof.hpf * 0.7) {
        out.push({
          id: 'hpf', tipo: 'hpf', freq: prof.hpf, prioridade: 100,
          titulo: `Ligar o filtro passa-altas (HPF) em ${fmtHz(prof.hpf)}`,
          porque: atual === null
            ? `Para ${prof.nome.toLowerCase()}, quase nada útil existe abaixo de ${fmtHz(prof.hpf)}. O filtro tira ronco, vento, batidas no pedestal e libera espaço para o baixo e o bumbo.`
            : `Hoje o HPF está em ${atual <= 21 ? 'desligado' : fmtHz(atual)}. Para ${prof.nome.toLowerCase()}, subir para ${fmtHz(prof.hpf)} tira ronco e sujeira sem mudar o timbre.`,
        });
      }
    }

    // 2) Zonas de corte e reforço
    const cand = [];
    prof.zonas.forEach(z => {
      const ids = THIRD.map((f, i) => i).filter(i => THIRD[i] >= z.lo && THIRD[i] <= z.hi && THIRD[i] >= lowMic);
      if (!ids.length) return;
      if (z.tipo === 'corte') {
        let best = ids[0]; ids.forEach(i => { if (dev[i] > dev[best]) best = i; });
        const d = dev[best];
        if (d < thr) return;
        let w = 1;
        for (let j = best - 1; j >= 0 && dev[j] > d - 3 && dev[j] > thr - 1.5; j--) w++;
        for (let j = best + 1; j < dev.length && dev[j] > d - 3 && dev[j] > thr - 1.5; j++) w++;
        const q = w <= 1 ? 2.5 : w === 2 ? 1.6 : w === 3 ? 1.1 : 0.8;
        // refina a frequência com interpolação parabólica no log
        let f = THIRD[best];
        if (best > 0 && best < dev.length - 1) {
          const a = dev[best - 1], b = dev[best], c = dev[best + 1], den = a - 2 * b + c;
          if (den < 0) f = f * Math.pow(2, clamp(0.5 * (a - c) / den, -0.5, 0.5) / 3);
        }
        const ganho = -clamp(Math.round(d * 0.6 * 2) / 2, 2, 6);
        cand.push({ tipo: 'banda', freq: roundHz(f), ganho, q, desvio: d, zona: z, prioridade: d });
      } else {
        let worst = ids[0]; ids.forEach(i => { if (dev[i] < dev[worst]) worst = i; });
        const d = dev[worst];
        if (d > -(thr + 1)) return;
        // só reforça se a zona inteira estiver baixa (não um vale estreito)
        const avg = ids.reduce((s, i) => s + dev[i], 0) / ids.length;
        if (avg > -(thr - 0.5)) return;
        const centro = Math.sqrt(z.lo * z.hi);
        const ganho = clamp(Math.round(-avg * 0.4 * 2) / 2, 1.5, 3);
        cand.push({ tipo: 'banda', freq: roundHz(centro), ganho, q: 1.0, desvio: avg, zona: z, prioridade: -avg * 0.7 });
      }
    });

    // 3) Ressonâncias estreitas persistentes
    (analysis.rings || []).forEach(r => {
      if (r.freq < 100 || r.freq > 12000) return;
      cand.push({
        tipo: 'banda', freq: roundHz(r.freq), ganho: -clamp(Math.round(r.prom * 0.4), 4, 8), q: 6, desvio: r.prom,
        zona: { nome: 'Ressonância / anel', ouve: 'uma nota que "zumbe" ou sobra sempre na mesma frequência (pode virar microfonia)' },
        prioridade: r.prom + 2, anel: true,
      });
    });

    // remove sobreposições (menos de 1/3 de oitava) e conflitos corte×reforço
    cand.sort((a, b) => b.prioridade - a.prioridade);
    const escolhidos = [];
    cand.forEach(c => {
      const choque = escolhidos.some(e => Math.abs(Math.log2(e.freq / c.freq)) < (c.anel || e.anel ? 0.12 : 0.4));
      if (!choque) escolhidos.push(c);
    });
    escolhidos.slice(0, 4).forEach((c, k) => {
      const corte = c.ganho < 0;
      out.push({
        id: 'b' + k + '_' + c.freq, tipo: 'banda', freq: c.freq, ganho: c.ganho, q: c.q, prioridade: c.prioridade,
        titulo: `${corte ? 'Cortar' : 'Reforçar'} ${Math.abs(c.ganho).toString().replace('.', ',')} dB em ${fmtHz(c.freq)} (Q ${String(c.q).replace('.', ',')}) — ${c.zona.nome}`,
        porque: c.anel
          ? `Há um pico estreito ${c.desvio.toFixed(0)} dB acima das frequências vizinhas, que persiste o tempo todo. Sintoma: ${c.zona.ouve}. Confirme de ouvido antes de cortar.`
          : corte
          ? `Essa região está ${c.desvio.toFixed(0)} dB acima do esperado para ${prof.nome.toLowerCase()}. Sintoma: ${c.zona.ouve}.`
          : `Essa região está ${Math.abs(c.desvio).toFixed(0)} dB abaixo do esperado. Sintoma: ${c.zona.ouve}. Antes de reforçar, confira se o problema não é volume ou posição do microfone.`,
      });
    });

    // 3b) Zumbido de rede elétrica (60 Hz e harmônicos)
    if (analysis.hum) {
      out.push({ id: 'hum', tipo: 'aviso', prioridade: 300,
        titulo: `Zumbido de energia detectado (${analysis.hum.join(', ')} Hz)`,
        porque: 'É o "hummm" de terra/aterramento, comum com notebook ou celular ligado no carregador. EQ não resolve: tire o carregador do notebook para testar, ligue tudo na mesma tomada da mesa, ou use um isolador de terra (DI ou "ground loop isolator" P2).' });
    }
    // 4) Ganho de entrada (a partir dos medidores da mesa)
    if (analysis.peakPreDb !== undefined && analysis.peakPreDb !== null && canal && canal.gainDb !== null) {
      const pk = analysis.peakPreDb;
      if (pk > -4) {
        const novo = Math.round((canal.gainDb - (pk + 12)) * 2) / 2;
        out.push({ id: 'gain', tipo: 'ganho', valor: novo, prioridade: 200,
          titulo: `Baixar o ganho de entrada para ${String(novo).replace('.', ',')} dB`,
          porque: `O pico chegou a ${pk.toFixed(0)} dB, muito perto de distorcer. Ganho certo vem antes de qualquer equalização.` });
      } else if (pk < -36) {
        const novo = Math.min(50, Math.round((canal.gainDb + (-18 - pk)) * 2) / 2);
        out.push({ id: 'gain', tipo: 'ganho', valor: novo, prioridade: 150,
          titulo: `Subir o ganho de entrada para ${String(novo).replace('.', ',')} dB`,
          porque: `O sinal está fraco (pico de ${pk.toFixed(0)} dB). Com pouco ganho você acaba subindo demais o fader e o ruído aparece.` });
      }
    }
    out.sort((a, b) => b.prioridade - a.prioridade);
    return { sugestoes: out, desvios: dev };
  }

  // Escolhe em qual banda do EQ aplicar uma sugestão
  function pickBand(canal, freq) {
    if (!canal) return 1;
    const oct = b => Math.abs(Math.log2(b.freq / freq));
    // 1) banda já mexida perto da mesma frequência
    const perto = canal.bands.filter(b => Math.abs(b.gain) >= 0.5 && oct(b) < 0.34).sort((a, b) => oct(a) - oct(b));
    if (perto.length) return perto[0].band;
    // 2) banda livre (ganho ~0), preferindo a "natural" pela frequência
    const natural = freq < 250 ? 1 : freq < 1500 ? 2 : freq < 5000 ? 3 : 4;
    const livres = canal.bands.filter(b => Math.abs(b.gain) < 0.5);
    if (livres.length) {
      livres.sort((a, b) => Math.abs(a.band - natural) - Math.abs(b.band - natural));
      return livres[0].band;
    }
    // 3) nenhuma livre: a de menor efeito
    return [...canal.bands].sort((a, b) => Math.abs(a.gain) - Math.abs(b.gain))[0].band;
  }

  // ---------- Detecção de picos estreitos num espectro fino (dB por bin) ----------
  // devolve [{bin, freq, prom, db}] — usa média local no domínio dB com somas prefixadas
  function narrowPeaks(db, sampleRate, fftSize, fMin = 80, fMax = 12000, minProm = 12) {
    const n = db.length, binHz = sampleRate / fftSize;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isFinite(db[i]) ? db[i] : -140);
    const out = [];
    const k0 = Math.max(3, Math.floor(fMin / binHz)), k1 = Math.min(n - 4, Math.ceil(fMax / binHz));
    for (let k = k0; k <= k1; k++) {
      const v = db[k];
      if (!(v >= db[k - 1] && v >= db[k + 1] && v > db[k - 2] && v > db[k + 2])) continue;
      const f = k * binHz;
      const half = Math.max(6, Math.round((f * (Math.pow(2, 1 / 6) - 1)) / binHz));
      const lo = Math.max(0, k - half), hi = Math.min(n - 1, k + half), ex = 3;
      const sum = pre[hi + 1] - pre[lo] - (pre[Math.min(n, k + ex + 1)] - pre[Math.max(0, k - ex)]);
      const cnt = (hi - lo + 1) - (Math.min(n, k + ex + 1) - Math.max(0, k - ex));
      if (cnt <= 0) continue;
      const prom = v - sum / cnt;
      if (prom >= minProm) {
        // interpolação parabólica para frequência precisa
        const a = db[k - 1], b = v, c = db[k + 1], den = a - 2 * b + c;
        const p = den < 0 ? 0.5 * (a - c) / den : 0;
        out.push({ bin: k, freq: (k + p) * binHz, prom, db: v });
      }
    }
    return out.sort((a, b) => b.prom - a.prom);
  }

  // Detector de microfonia em tempo real: chame update() a cada quadro
  function FeedbackDetector(opts = {}) {
    const holdMs = opts.holdMs || 350, minProm = opts.minProm || 16, minDb = opts.minDb || -70;
    let cand = null; const alerted = [];
    return {
      update(db, sampleRate, fftSize, tMs) {
        const peaks = narrowPeaks(db, sampleRate, fftSize, 80, 12000, minProm).filter(p => p.db > minDb).slice(0, 3);
        if (!peaks.length) { cand = null; return null; }
        const p = peaks[0];
        if (cand && Math.abs(p.bin - cand.bin) <= 2) {
          cand.last = tMs; cand.freq = p.freq; cand.prom = Math.max(cand.prom, p.prom); cand.db = p.db; cand.bin = p.bin;
          if (!cand.fired && tMs - cand.start >= holdMs) {
            cand.fired = true;
            const ev = { freq: cand.freq, prom: cand.prom, db: cand.db, t: tMs };
            alerted.push(ev); return ev;
          }
        } else {
          cand = { bin: p.bin, freq: p.freq, prom: p.prom, db: p.db, start: tMs, last: tMs, fired: false };
        }
        return null;
      },
      reset() { cand = null; },
      history: alerted,
      current: () => cand,
    };
  }

  // procura picos estreitos em 60/120/180/240 Hz num espectro médio (dB por bin)
  function detectHum(avgDb, sampleRate, fftSize) {
    const tol = Math.max(3, 0.8 * sampleRate / fftSize);
    const pk = narrowPeaks(avgDb, sampleRate, fftSize, 45, 260, 6);
    const near = h => pk.find(p => Math.abs(p.freq - h) < tol);
    const hits = [60, 120, 180, 240].filter(near);
    // exige 60 Hz (a fundamental da rede no Brasil) + um harmônico, ou 60 Hz bem destacado
    if (hits.includes(60) && (hits.length >= 2 || near(60).prom > 15)) return hits;
    return null;
  }
  const NOTES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
  function noteName(f) {
    const m = Math.round(69 + 12 * Math.log2(f / 440));
    return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  return {
    clamp, freqToNorm, normToFreq, qToNorm, normToQ, eqGainToNorm, normToEqGain, inGainToNorm, normToInGain, vuToDb,
    parseLines, parseLine, decodeVu, cmd, P, readChannel, linkedChannels,
    peakingDb, hpfDb, eqResponse, THIRD, thirdOctave, PROFILES, guessProfile, interpTarget, deviations, suggest, pickBand,
    narrowPeaks, FeedbackDetector, noteName, fmtHz, roundHz, HPF_SLOPES, NIN, LINE_L, LINE_R, isLine, detectHum,
  };
})();
if (typeof module !== 'undefined') module.exports = Core;
