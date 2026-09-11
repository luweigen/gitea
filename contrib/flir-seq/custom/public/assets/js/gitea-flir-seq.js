// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// contrib/flir-seq: view FLIR radiometric sequences (.seq / .fff) in Gitea's
// file view and read the temperature of any picked point.
//
// This file is a plain script -- no bundler, no dependency, no network access
// beyond the raw file it is asked to display. It is also loadable from Node
// (module.exports below) so that contrib/flir-seq/test can exercise the
// parser and the radiometry without a browser.

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.GiteaFlirSeq = api;
    if (root.document) api.init(root.document);
  }
})(typeof window === 'undefined' ? null : window, function () {
  // ------------------------------------------------------------------
  // configuration
  // ------------------------------------------------------------------

  const DEFAULTS = {
    // file extensions that get a viewer, lower case, with the dot
    extensions: ['.seq', '.fff'],
    // files larger than this are only loaded after an explicit click, because
    // the whole file is pulled into memory
    maxAutoLoadBytes: 64 * 1024 * 1024,
    // hard stop: never load more than this
    maxLoadBytes: 1024 * 1024 * 1024,
    // 'iron' | 'rainbow' | 'white-hot' | 'black-hot' | 'arctic'
    defaultPalette: 'iron',
    // 'frame' (auto-scale each frame) | 'sequence' | 'manual'
    defaultRangeMode: 'frame',
    // playback speed for multi-frame sequences
    playbackFps: 6,
    // digits after the decimal point in every temperature readout
    decimals: 1,
    // viewer height cap, as a fraction of the viewport height
    maxHeightVh: 0.72,
    // 'en' | 'zh-CN' | 'fi-FI', or null to follow Gitea's own language
    lang: null,
  };

  function config() {
    const user = (typeof window !== 'undefined' && window.giteaFlirSeqConfig) || {};
    return Object.assign({}, DEFAULTS, user);
  }

  // ------------------------------------------------------------------
  // translations
  //
  // Gitea renders the active language into <html lang="...">, so the viewer
  // follows the site language without any configuration. English is both the
  // fallback and the reference: every other language must define exactly the
  // same keys, which contrib/flir-seq/test checks.
  //
  // Placeholders are {0}, {1}, ... and are substituted positionally.
  // ------------------------------------------------------------------

  const LANGUAGES = {
    'en': {
      palette: 'Palette',
      paletteIron: 'Iron',
      paletteRainbow: 'Rainbow',
      paletteWhiteHot: 'White hot',
      paletteBlackHot: 'Black hot',
      paletteArctic: 'Arctic',
      scale: 'Scale',
      scaleFrame: 'Per frame',
      scaleSequence: 'Whole sequence',
      scaleManual: 'Manual',
      scaleMin: 'Min',
      scaleMax: 'Max',
      extremes: 'Hot/cold spot',
      filterHigh: 'Upper limit of the displayed temperature window',
      filterLow: 'Lower limit of the displayed temperature window',
      filterReset: 'Show all',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomFit: 'Fit to window',
      play: 'Play',
      pause: 'Pause',
      prevFrame: 'Previous frame',
      nextFrame: 'Next frame',
      frameLabel: 'Frame {0} of {1}',
      singleFrame: 'Single frame',
      spots: 'Spot meters',
      spotsHint: 'Click the image to add a spot meter. Drag to pan, scroll to zoom.',
      colX: 'X',
      colY: 'Y',
      colRaw: 'Raw value',
      colTemp: 'Temperature',
      delete: 'Delete',
      clearAll: 'Clear all',
      noSpots: 'No spot meters yet',
      params: 'Measurement parameters',
      emissivity: 'Emissivity ε',
      reflectedTemp: 'Reflected apparent temperature (°C)',
      objectDistance: 'Object distance (m)',
      relativeHumidity: 'Relative humidity (%)',
      atmTransmission: 'Atmospheric transmission (0 = estimate)',
      atmosphericTemp: 'Atmospheric temperature (°C)',
      irWindowTemp: 'IR window temperature (°C)',
      irWindowTransmission: 'IR window transmission',
      resetParams: 'Restore camera settings',
      planckNote: 'Planck constants: R1={0}, R2={1}, B={2}, F={3}, O={4} (from the file, not editable)',
      fileInfo: 'File information',
      metaFile: 'File',
      metaFrames: 'Frames',
      metaResolution: 'Resolution',
      metaCamera: 'Camera',
      metaFirmware: 'Firmware',
      metaLens: 'Lens',
      metaFov: 'Field of view',
      metaCaptured: 'Captured',
      metaFrameRate: 'Frame rate',
      metaRange: 'Temperature range',
      metaContainer: 'Container',
      tauNote: 'Atmospheric transmission in use: {0} ({1})',
      tauFromFile: 'from the file',
      tauManual: 'entered by hand',
      tauEstimated: 'estimated from distance, humidity and air temperature',
      metaPixelValues: 'Pixel value type / unit',
      unknown: 'unknown',
      exportPng: 'Export PNG',
      exportCsv: 'Export temperature CSV',
      readoutHint: 'Move the pointer over the image to read the temperature at that point.',
      readout: '({0}, {1}) · {2} · {3}',
      readoutRaw: 'raw value {0}',
      hottest: 'Max {0}',
      coldest: 'Min {0}',
      rawUnit: '{0} counts',
      downloading: 'Downloading {0} …',
      parsing: 'Parsing the FLIR sequence …',
      downloadFailed: 'Download failed: {0}',
      parseFailed: 'Parsing failed: {0}',
      notFlir: 'No FLIR FFF frame was found; this is probably not a FLIR thermal sequence.',
      tooLarge: 'The file is {0}, which is over the maxLoadBytes limit, so it was not loaded.',
      confirmLoad: 'This thermal sequence is {0} and has to be read into memory as a whole.',
      loadAnyway: 'Load anyway',
      frameUndecodable: 'This frame cannot be decoded',
      unknownSize: 'unknown size',
      errNoRawRecord: 'This frame has no RawData record',
      errRawPng: "This frame's raw data is PNG-compressed, which is not supported",
      errRawUnsupported: "This frame's RawData record is not uncompressed 16-bit data",
      warnResync: 'Resynchronised to the next frame at offset {0}',
      warnPixelType: 'This file marks its pixel values as type {0} / unit {1}. Only type 1 (sensor counts) has been verified, so the temperatures below may not apply -- check them against FLIR\'s own tools.',
      warnFrameHeader: 'The frame header at offset {0} could not be parsed, so parsing stopped there',
      errNoPlanck: 'The file has no Planck calibration constants (R1/R2/B), so temperatures cannot be computed',
      errBadEmissivity: 'Emissivity and IR window transmission must both be greater than 0',
      errBadTau: 'The atmospheric transmission came out invalid; check the distance, humidity and air temperature',
    },

    'zh-CN': {
      palette: '调色板',
      paletteIron: '铁红',
      paletteRainbow: '彩虹',
      paletteWhiteHot: '白热',
      paletteBlackHot: '黑热',
      paletteArctic: '极地',
      scale: '温标',
      scaleFrame: '本帧自动',
      scaleSequence: '全序列自动',
      scaleManual: '手动',
      scaleMin: '下限',
      scaleMax: '上限',
      extremes: '最高/最低点',
      filterHigh: '显示温区上限',
      filterLow: '显示温区下限',
      filterReset: '显示全部',
      zoomIn: '放大',
      zoomOut: '缩小',
      zoomFit: '适应窗口',
      play: '播放',
      pause: '暂停',
      prevFrame: '上一帧',
      nextFrame: '下一帧',
      frameLabel: '第 {0} / {1} 帧',
      singleFrame: '单帧',
      spots: '测温点',
      spotsHint: '在图像上单击可添加测温点，拖动可平移，滚轮可缩放。',
      colX: 'X',
      colY: 'Y',
      colRaw: '原始值',
      colTemp: '温度',
      delete: '删除',
      clearAll: '清除全部',
      noSpots: '还没有测温点',
      params: '测温参数',
      emissivity: '发射率 ε',
      reflectedTemp: '反射表观温度 (°C)',
      objectDistance: '目标距离 (m)',
      relativeHumidity: '相对湿度 (%)',
      atmTransmission: '大气透过率（0＝自动估算）',
      atmosphericTemp: '大气温度 (°C)',
      irWindowTemp: '红外窗口温度 (°C)',
      irWindowTransmission: '窗口透过率',
      resetParams: '恢复相机设定',
      planckNote: 'Planck 常数：R1={0}，R2={1}，B={2}，F={3}，O={4}（来自文件，不可编辑）',
      fileInfo: '文件信息',
      metaFile: '文件',
      metaFrames: '帧数',
      metaResolution: '分辨率',
      metaCamera: '相机',
      metaFirmware: '固件',
      metaLens: '镜头',
      metaFov: '视场角',
      metaCaptured: '采集时间',
      metaFrameRate: '帧率',
      metaRange: '量程',
      metaContainer: '容器格式',
      tauNote: '当前大气透过率：{0}（{1}）',
      tauFromFile: '来自文件',
      tauManual: '手动输入',
      tauEstimated: '按距离、湿度与大气温度估算',
      metaPixelValues: '像素值类型 / 单位',
      unknown: '未知',
      exportPng: '导出 PNG',
      exportCsv: '导出温度 CSV',
      readoutHint: '把鼠标移到图像上即可读取该点温度。',
      readout: '({0}, {1})　{2}　{3}',
      readoutRaw: '原始值 {0}',
      hottest: '最高 {0}',
      coldest: '最低 {0}',
      rawUnit: '{0} 计数',
      downloading: '正在下载 {0} …',
      parsing: '正在解析 FLIR 序列 …',
      downloadFailed: '下载失败：{0}',
      parseFailed: '解析失败：{0}',
      notFlir: '文件中没有找到 FLIR FFF 帧，可能不是 FLIR 热成像序列。',
      tooLarge: '文件过大（{0}），超过 maxLoadBytes 限制，不予加载。',
      confirmLoad: '这是一个 {0} 的热成像序列，需要整体读入内存。',
      loadAnyway: '仍然加载',
      frameUndecodable: '该帧无法解码',
      unknownSize: '未知大小',
      errNoRawRecord: '该帧没有 RawData 记录',
      errRawPng: '该帧的原始数据是 PNG 压缩格式，暂不支持',
      errRawUnsupported: '该帧的 RawData 记录不是未压缩的 16 位数据',
      warnResync: '在偏移 {0} 处重新同步到下一帧',
      warnPixelType: '该文件标记的像素值类型为 {0} / 单位 {1}。目前只验证过类型 1（原始计数），下面的温度换算可能不适用，请与 FLIR 官方工具核对。',
      warnFrameHeader: '偏移 {0} 处的帧头无法解析，已停止',
      errNoPlanck: '该文件缺少 Planck 标定常数（R1/R2/B），无法换算温度',
      errBadEmissivity: '发射率与红外窗口透过率必须大于 0',
      errBadTau: '大气透过率计算结果无效，请检查距离/湿度/大气温度',
    },

    'fi-FI': {
      palette: 'Väripaletti',
      paletteIron: 'Rauta',
      paletteRainbow: 'Sateenkaari',
      paletteWhiteHot: 'Valkoinen kuuma',
      paletteBlackHot: 'Musta kuuma',
      paletteArctic: 'Arktinen',
      scale: 'Asteikko',
      scaleFrame: 'Ruudun mukaan',
      scaleSequence: 'Koko sarjan mukaan',
      scaleManual: 'Käsin',
      scaleMin: 'Alaraja',
      scaleMax: 'Yläraja',
      extremes: 'Kuumin/kylmin piste',
      filterHigh: 'Näytettävän lämpötila-alueen yläraja',
      filterLow: 'Näytettävän lämpötila-alueen alaraja',
      filterReset: 'Näytä kaikki',
      zoomIn: 'Lähennä',
      zoomOut: 'Loitonna',
      zoomFit: 'Sovita ikkunaan',
      play: 'Toista',
      pause: 'Keskeytä',
      prevFrame: 'Edellinen ruutu',
      nextFrame: 'Seuraava ruutu',
      frameLabel: 'Ruutu {0} / {1}',
      singleFrame: 'Yksi ruutu',
      spots: 'Mittapisteet',
      spotsHint: 'Lisää mittapiste napsauttamalla kuvaa. Raahaa siirtääksesi kuvaa, vieritä zoomataksesi.',
      colX: 'X',
      colY: 'Y',
      colRaw: 'Raaka-arvo',
      colTemp: 'Lämpötila',
      delete: 'Poista',
      clearAll: 'Tyhjennä kaikki',
      noSpots: 'Ei vielä mittapisteitä',
      params: 'Mittausparametrit',
      emissivity: 'Emissiivisyys ε',
      reflectedTemp: 'Heijastunut näennäislämpötila (°C)',
      objectDistance: 'Etäisyys kohteeseen (m)',
      relativeHumidity: 'Suhteellinen kosteus (%)',
      atmTransmission: 'Ilmakehän läpäisy (0 = arvioidaan)',
      atmosphericTemp: 'Ilman lämpötila (°C)',
      irWindowTemp: 'IR-ikkunan lämpötila (°C)',
      irWindowTransmission: 'IR-ikkunan läpäisy',
      resetParams: 'Palauta kameran asetukset',
      planckNote: 'Planckin vakiot: R1={0}, R2={1}, B={2}, F={3}, O={4} (tiedostosta, ei muokattavissa)',
      fileInfo: 'Tiedoston tiedot',
      metaFile: 'Tiedosto',
      metaFrames: 'Ruutuja',
      metaResolution: 'Tarkkuus',
      metaCamera: 'Kamera',
      metaFirmware: 'Laiteohjelmisto',
      metaLens: 'Objektiivi',
      metaFov: 'Kuvakulma',
      metaCaptured: 'Kuvausaika',
      metaFrameRate: 'Kuvataajuus',
      metaRange: 'Mittausalue',
      metaContainer: 'Säiliömuoto',
      tauNote: 'Käytössä oleva ilmakehän läpäisy: {0} ({1})',
      tauFromFile: 'tiedostosta',
      tauManual: 'syötetty käsin',
      tauEstimated: 'arvioitu etäisyydestä, kosteudesta ja ilman lämpötilasta',
      metaPixelValues: 'Pikseliarvojen tyyppi / yksikkö',
      unknown: 'tuntematon',
      exportPng: 'Vie PNG',
      exportCsv: 'Vie lämpötilat CSV:nä',
      readoutHint: 'Vie osoitin kuvan päälle lukeaksesi kyseisen pisteen lämpötilan.',
      readout: '({0}, {1}) · {2} · {3}',
      readoutRaw: 'raaka-arvo {0}',
      hottest: 'Kuumin {0}',
      coldest: 'Kylmin {0}',
      rawUnit: '{0} yksikköä',
      downloading: 'Ladataan {0} …',
      parsing: 'Jäsennetään FLIR-sarjaa …',
      downloadFailed: 'Lataus epäonnistui: {0}',
      parseFailed: 'Jäsennys epäonnistui: {0}',
      notFlir: 'Tiedostosta ei löytynyt FLIR FFF -ruutuja; se ei ilmeisesti ole FLIR-lämpökuvasarja.',
      tooLarge: 'Tiedosto on {0} ja ylittää maxLoadBytes-rajan, joten sitä ei ladattu.',
      confirmLoad: 'Tämä lämpökuvasarja on {0}, ja se on luettava kokonaan muistiin.',
      loadAnyway: 'Lataa silti',
      frameUndecodable: 'Tätä ruutua ei voi purkaa',
      unknownSize: 'tuntematon koko',
      errNoRawRecord: 'Ruudussa ei ole RawData-tietuetta',
      errRawPng: 'Ruudun raakadata on PNG-pakattua, mitä ei tueta',
      errRawUnsupported: 'Ruudun RawData-tietue ei ole pakkaamatonta 16-bittistä dataa',
      warnResync: 'Synkronoitiin uudelleen seuraavaan ruutuun kohdassa {0}',
      warnPixelType: 'Tiedosto merkitsee pikseliarvonsa tyypiksi {0} / yksiköksi {1}. Vain tyyppi 1 (raaka-arvot) on varmennettu, joten alla olevat lämpötilat eivät välttämättä päde -- tarkista ne FLIRin omilla työkaluilla.',
      warnFrameHeader: 'Ruudun otsaketta kohdassa {0} ei voitu jäsentää, joten jäsennys päättyi siihen',
      errNoPlanck: 'Tiedostosta puuttuvat Planckin kalibrointivakiot (R1/R2/B), joten lämpötilaa ei voi laskea',
      errBadEmissivity: 'Emissiivisyyden ja IR-ikkunan läpäisyn on oltava suurempia kuin 0',
      errBadTau: 'Ilmakehän läpäisyn laskenta antoi virheellisen tuloksen; tarkista etäisyys, kosteus ja ilman lämpötila',
    },
  };

  const FALLBACK_LANG = 'en';

  /** Pick a translation for a BCP 47 tag: exact match first, then its primary
   *  subtag (so zh-TW lands on zh-CN and fi lands on fi-FI). */
  function matchLanguage(tag) {
    if (!tag) return null;
    const wanted = String(tag).toLowerCase();
    const keys = Object.keys(LANGUAGES);
    const exact = keys.find((k) => k.toLowerCase() === wanted);
    if (exact) return exact;
    const primary = wanted.split('-')[0];
    return keys.find((k) => k.toLowerCase().split('-')[0] === primary) || null;
  }

  /**
   * Resolve the language to use: the configured one, else what Gitea put in
   * <html lang="...">, else English.
   */
  function resolveLang(preferred) {
    const documentLang = typeof document === 'undefined' ? null : document.documentElement.lang;
    return matchLanguage(preferred) || matchLanguage(documentLang) || FALLBACK_LANG;
  }

  /** t(key, [a, b, ...]) -- substitutes {0}, {1}, ... positionally. */
  function makeTranslator(preferred) {
    const lang = resolveLang(preferred);
    const strings = LANGUAGES[lang];
    const t = function (key, args) {
      const text = (key in strings ? strings[key] : LANGUAGES[FALLBACK_LANG][key]);
      if (text === undefined) return key; // a typo in a key must be visible, not silent
      if (!args || !args.length) return text;
      return text.replace(/\{(\d+)\}/g, (match, i) => (args[i] === undefined ? match : String(args[i])));
    };
    t.lang = lang;
    return t;
  }

  // ------------------------------------------------------------------
  // FFF container parsing
  //
  // A .seq file is a bare concatenation of FLIR "FFF" frames. Every frame
  // starts with a 0x40 byte header holding the offset and the length of a
  // record index; each 32 byte index entry points at a record inside the same
  // frame. Only two record types matter here:
  //
  //   type 1  (RawData)    32 byte header + width*height uint16 sensor counts
  //   type 32 (CameraInfo) the calibration block, see CAMERA_INFO_FIELDS
  //
  // The container header is big-endian on the cameras seen so far while the
  // records themselves are little-endian, so byte order is decided separately
  // for each of them instead of being assumed.
  // ------------------------------------------------------------------

  // The pixel value type seen on every file this viewer was verified against.
  // Anything else may not be sensor counts, so the reading is flagged.
  const VERIFIED_PIXEL_VALUE_TYPE = 1;

  const REC_RAW_DATA = 1;
  const REC_CAMERA_INFO = 32;
  const FRAME_HEADER_SIZE = 0x40;
  const INDEX_ENTRY_SIZE = 32;
  const RAW_HEADER_SIZE = 32;

  function hasMagic(bytes, off) {
    if (off + 4 > bytes.length) return false;
    // "FFF\0" for camera files, "AFF\0" for the ATS variant
    return (bytes[off] === 0x46 || bytes[off] === 0x41) &&
      bytes[off + 1] === 0x46 && bytes[off + 2] === 0x46 && bytes[off + 3] === 0x00;
  }

  function findMagic(bytes, from) {
    for (let i = from; i + 4 <= bytes.length; i++) {
      if (hasMagic(bytes, i)) return i;
    }
    return -1;
  }

  function readString(dv, off, len) {
    let out = '';
    for (let i = 0; i < len; i++) {
      if (off + i >= dv.byteLength) break;
      const c = dv.getUint8(off + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.trim();
  }

  // Offsets are relative to the start of the CameraInfo record. They come from
  // ExifTool's FLIR::CameraInfo table, which is the only public description of
  // this block; every offset below was re-checked against real A655sc frames.
  const CAMERA_INFO_FIELDS = {
    emissivity: [0x20, 'f'],
    objectDistance: [0x24, 'f'],
    reflectedTempK: [0x28, 'f'],
    atmosphericTempK: [0x2c, 'f'],
    irWindowTempK: [0x30, 'f'],
    irWindowTransmission: [0x34, 'f'],
    // CObjectParametersReduceObject::estAtmosphericTransmission -- "set to 0 to
    // calculate from relHum, distance, atmTemp". When the camera was given a
    // transmission by hand it lands here and must be used as-is.
    estAtmTransmission: [0x38, 'f'],
    relativeHumidity: [0x3c, 'f'],
    // What the samples hold. Only type 1 (sensor counts) has been verified
    // against real files; see warnPixelType.
    pixelValueType: [0x50, 'u'],
    pixelValueUnit: [0x54, 'u'],
    planckR1: [0x58, 'f'],
    planckB: [0x5c, 'f'],
    planckF: [0x60, 'f'],
    atmTransAlpha1: [0x70, 'f'],
    atmTransAlpha2: [0x74, 'f'],
    atmTransBeta1: [0x78, 'f'],
    atmTransBeta2: [0x7c, 'f'],
    atmTransX: [0x80, 'f'],
    cameraTempRangeMaxK: [0x90, 'f'],
    cameraTempRangeMinK: [0x94, 'f'],
    cameraModel: [0xd4, 's', 32],
    cameraPartNumber: [0xf4, 's', 16],
    cameraSerialNumber: [0x104, 's', 16],
    cameraSoftware: [0x114, 's', 16],
    lensModel: [0x170, 's', 32],
    lensPartNumber: [0x190, 's', 16],
    lensSerialNumber: [0x1a0, 's', 16],
    fieldOfView: [0x1b4, 'f'],
    filterModel: [0x1ec, 's', 16],
    planckO: [0x308, 'i'],
    planckR2: [0x30c, 'f'],
    rawValueMedian: [0x338, 'i'],
    rawValueRange: [0x33c, 'i'],
    dateTimeSeconds: [0x384, 'u'],
    dateTimeSubSec: [0x388, 'u'],
    dateTimeTZ: [0x38c, 'h'],
    focusStepCount: [0x390, 'w'],
    focusDistance: [0x45c, 'f'],
    frameRate: [0x464, 'w'],
  };

  function parseCameraInfo(dv, base, size) {
    // The record opens with the same 32 byte image header as RawData, whose
    // first uint16 is 2. That is what tells us the byte order of the block.
    let le = true;
    if (base + 2 <= dv.byteLength && dv.getUint16(base, true) !== 2 && dv.getUint16(base, false) === 2) le = false;

    const info = {byteOrderLE: le};
    for (const name of Object.keys(CAMERA_INFO_FIELDS)) {
      const spec = CAMERA_INFO_FIELDS[name];
      const off = base + spec[0];
      const need = spec[1] === 's' ? spec[2] : (spec[1] === 'w' || spec[1] === 'h' ? 2 : 4);
      if (spec[0] + need > size || off + need > dv.byteLength) continue;
      switch (spec[1]) {
        case 'f': info[name] = dv.getFloat32(off, le); break;
        case 'i': info[name] = dv.getInt32(off, le); break;
        case 'u': info[name] = dv.getUint32(off, le); break;
        case 'h': info[name] = dv.getInt16(off, le); break;
        case 'w': info[name] = dv.getUint16(off, le); break;
        case 's': info[name] = readString(dv, off, spec[2]); break;
      }
    }

    // The camera stores a fraction on some models and whole percent on others.
    if (typeof info.relativeHumidity === 'number' && info.relativeHumidity <= 1.5) {
      info.relativeHumidity *= 100;
    }
    if (typeof info.dateTimeSeconds === 'number' && info.dateTimeSeconds > 0) {
      // The sub-second count lives in the low 16 bits. The time zone is stored
      // in minutes and, following ExifTool, the timestamp is shifted by it
      // while the offset is reported with the opposite sign.
      const ms = (info.dateTimeSubSec || 0) & 0xffff;
      const tz = info.dateTimeTZ || 0;
      info.dateTime = new Date((info.dateTimeSeconds - tz * 60) * 1000 + ms);
      info.dateTimeOffsetMinutes = -tz;
    }
    return info;
  }

  function parseFrameHeader(dv, bytes, base) {
    // Try big-endian first: that is what every FFF file seen so far uses, and
    // a wrong guess is caught by the plausibility check below.
    for (const le of [false, true]) {
      const indexOff = dv.getUint32(base + 0x18, le);
      const indexCount = dv.getUint32(base + 0x1c, le);
      if (indexOff < FRAME_HEADER_SIZE || indexCount === 0 || indexCount > 4096) continue;
      const indexEnd = base + indexOff + indexCount * INDEX_ENTRY_SIZE;
      if (indexEnd > bytes.length) continue;

      const records = [];
      let frameEnd = indexOff + indexCount * INDEX_ENTRY_SIZE;
      let sane = true;
      for (let i = 0; i < indexCount; i++) {
        const p = base + indexOff + i * INDEX_ENTRY_SIZE;
        const rec = {
          type: dv.getUint16(p, le),
          subtype: dv.getUint16(p + 2, le),
          version: dv.getUint32(p + 4, le),
          id: dv.getUint32(p + 8, le),
          offset: dv.getUint32(p + 12, le),
          length: dv.getUint32(p + 16, le),
        };
        if (rec.type === 0 && rec.length === 0) continue; // unused slot
        if (rec.offset < FRAME_HEADER_SIZE || base + rec.offset + rec.length > bytes.length) {
          sane = false;
          break;
        }
        records.push(rec);
        frameEnd = Math.max(frameEnd, rec.offset + rec.length);
      }
      if (!sane || !records.length) continue;
      return {headerLE: le, format: readString(dv, base + 4, 16), records, frameEnd};
    }
    return null;
  }

  function parseRawHeader(dv, base, length) {
    if (length < RAW_HEADER_SIZE) return null;
    for (const le of [true, false]) {
      if (dv.getUint16(base, le) !== 2) continue;
      const width = dv.getUint16(base + 2, le);
      const height = dv.getUint16(base + 4, le);
      if (width > 0 && height > 0 && RAW_HEADER_SIZE + width * height * 2 <= length) {
        return {le, width, height, pixelOffset: base + RAW_HEADER_SIZE};
      }
    }
    return null;
  }

  /**
   * Parse a .seq / .fff buffer into a list of frames. Pixel data is *not*
   * decoded here: a frame only remembers where its samples are, so a multi
   * gigabyte sequence costs no more than the buffer itself.
   */
  function parseSeq(buffer) {
    // Warnings and errors are reported as {key, args} so that the parser stays
    // free of user-visible text; the viewer runs them through its translator.
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const frames = [];
    const warnings = [];
    let off = 0;

    while (off + FRAME_HEADER_SIZE <= bytes.length) {
      if (!hasMagic(bytes, off)) {
        // Some recorders pad frames; resynchronise on the next magic instead
        // of giving up on the rest of the file.
        const next = findMagic(bytes, off + 1);
        if (next < 0) break;
        if (frames.length) warnings.push({key: 'warnResync', args: [off]});
        off = next;
        continue;
      }

      const head = parseFrameHeader(dv, bytes, off);
      if (!head) {
        warnings.push({key: 'warnFrameHeader', args: [off]});
        break;
      }

      const rawRec = head.records.find((r) => r.type === REC_RAW_DATA);
      const infoRec = head.records.find((r) => r.type === REC_CAMERA_INFO);
      const frame = {
        index: frames.length,
        offset: off,
        format: head.format,
        records: head.records,
        info: infoRec ? parseCameraInfo(dv, off + infoRec.offset, infoRec.length) : null,
        raw: null,
        error: null,
      };

      if (!rawRec) {
        frame.error = {key: 'errNoRawRecord'};
      } else {
        const raw = parseRawHeader(dv, off + rawRec.offset, rawRec.length);
        if (!raw) {
          const magic = dv.getUint32(off + rawRec.offset + RAW_HEADER_SIZE, false);
          frame.error = {key: magic === 0x89504e47 ? 'errRawPng' : 'errRawUnsupported'};
        } else {
          frame.raw = raw;
        }
      }

      frames.push(frame);
      if (frames.length === 1 && frame.info && frame.info.pixelValueType !== undefined &&
          frame.info.pixelValueType !== VERIFIED_PIXEL_VALUE_TYPE) {
        warnings.push({key: 'warnPixelType', args: [frame.info.pixelValueType, frame.info.pixelValueUnit]});
      }

      const next = off + head.frameEnd;
      if (next <= off) break;
      off = next;
    }

    return {frames, warnings};
  }

  /** Decode one frame's sensor counts into a Uint16Array of width*height. */
  function readFramePixels(buffer, frame) {
    if (!frame.raw) return null;
    const {le, width, height, pixelOffset} = frame.raw;
    const count = width * height;
    const platformLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (le === platformLE && pixelOffset % 2 === 0) {
      return new Uint16Array(buffer, pixelOffset, count);
    }
    const dv = new DataView(buffer);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getUint16(pixelOffset + i * 2, le);
    return out;
  }

  // ------------------------------------------------------------------
  // radiometry
  //
  // The FLIR object-signal model, as published by FLIR and reproduced in
  // Thermimage's raw2temp(): strip the reflected, atmospheric and window
  // contributions off the measured signal, then invert Planck's law.
  // ------------------------------------------------------------------

  const K0 = 273.15;

  /** Calibration + object parameters of a frame, as editable numbers (deg C). */
  function paramsFromInfo(info) {
    const i = info || {};
    return {
      emissivity: num(i.emissivity, 0.95),
      objectDistance: num(i.objectDistance, 1),
      reflectedTemp: num(i.reflectedTempK, 293.15) - K0,
      atmosphericTemp: num(i.atmosphericTempK, 293.15) - K0,
      irWindowTemp: num(i.irWindowTempK, 293.15) - K0,
      irWindowTransmission: num(i.irWindowTransmission, 1),
      relativeHumidity: num(i.relativeHumidity, 50),
      // 0 means "not set by the camera, estimate it from distance and humidity"
      atmTransmission: num(i.estAtmTransmission, 0),
      planckR1: num(i.planckR1, 0),
      planckR2: num(i.planckR2, 0),
      planckB: num(i.planckB, 1400),
      planckF: num(i.planckF, 1),
      planckO: num(i.planckO, 0),
      atmTransAlpha1: num(i.atmTransAlpha1, 0.006569),
      atmTransAlpha2: num(i.atmTransAlpha2, 0.01262),
      atmTransBeta1: num(i.atmTransBeta1, -0.002276),
      atmTransBeta2: num(i.atmTransBeta2, -0.00667),
      atmTransX: num(i.atmTransX, 1.9),
    };
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  /** Signal of a black body at t degrees Celsius, in sensor counts. */
  function planckRaw(p, t) {
    return p.planckR1 / (p.planckR2 * (Math.exp(p.planckB / (t + K0)) - p.planckF)) - p.planckO;
  }

  /** True when the file (or the user) supplied a usable transmission outright. */
  function hasAtmTransmission(p) {
    return p.atmTransmission > 0 && p.atmTransmission <= 1;
  }

  /**
   * Atmospheric transmission. A value carried by the file wins outright, which
   * is what the FLIR SDK prescribes for estAtmosphericTransmission; only when
   * it is 0 is the transmission estimated from distance, humidity and air
   * temperature. Values outside (0, 1] cannot be a transmission and are
   * estimated instead.
   */
  function atmosphericTransmission(p) {
    if (hasAtmTransmission(p)) return p.atmTransmission;
    const rh = p.relativeHumidity / 100;
    const at = p.atmosphericTemp;
    // water vapour pressure, FLIR's polynomial fit
    const h2o = rh * Math.exp(1.5587 + 0.06939 * at - 0.00027816 * at * at + 0.00000068455 * at * at * at);
    const d = Math.sqrt(Math.max(p.objectDistance, 0) / 2);
    const root = Math.sqrt(Math.max(h2o, 0));
    return p.atmTransX * Math.exp(-d * (p.atmTransAlpha1 + p.atmTransBeta1 * root)) +
      (1 - p.atmTransX) * Math.exp(-d * (p.atmTransAlpha2 + p.atmTransBeta2 * root));
  }

  /**
   * Build the raw-count -> degrees Celsius conversion for one parameter set.
   * Returns {ok, reason, toTemp(raw), toRaw(tempC), lut}, where "reason" is a
   * translation key rather than a sentence. The lookup table covers the whole
   * uint16 domain so per-pixel conversion is a single index.
   */
  function makeConverter(p) {
    const invalid = (reason) => ({
      ok: false, reason,
      toTemp: () => NaN,
      toRaw: () => NaN,
      lut: null,
    });

    if (!(p.planckR1 > 0) || !(p.planckR2 > 0) || !(p.planckB > 0)) return invalid('errNoPlanck');
    const e = p.emissivity;
    const irt = p.irWindowTransmission;
    if (!(e > 0) || !(irt > 0)) return invalid('errBadEmissivity');

    const tau = atmosphericTransmission(p);
    if (!(tau > 0)) return invalid('errBadTau');

    const emissWindow = 1 - irt;
    const rawRefl = planckRaw(p, p.reflectedTemp);
    const rawAtm = planckRaw(p, p.atmosphericTemp);
    const rawWind = planckRaw(p, p.irWindowTemp);

    // attenuation terms, all constant for a given parameter set
    const attnRefl = (1 - e) / e * rawRefl;
    const attnAtm1 = (1 - tau) / e / tau * rawAtm;
    const attnAtm2 = (1 - tau) / e / tau / irt / tau * rawAtm;
    const attnWind = emissWindow / e / irt / tau * rawWind;
    const gain = 1 / e / tau / irt / tau;
    const offset = -(attnAtm1 + attnAtm2 + attnWind + attnRefl);

    const toTemp = (raw) => {
      const objectSignal = raw * gain + offset;
      const v = p.planckR1 / (p.planckR2 * (objectSignal + p.planckO)) + p.planckF;
      if (!(v > 0)) return NaN;
      const t = p.planckB / Math.log(v) - K0;
      return isFinite(t) ? t : NaN;
    };

    // inverse, used to turn a manual temperature range back into raw counts
    const toRaw = (t) => (planckRaw(p, t) - offset) / gain;

    const lut = new Float32Array(65536);
    for (let raw = 0; raw < 65536; raw++) lut[raw] = toTemp(raw);

    return {ok: true, reason: '', toTemp, toRaw, lut, tau, tauFromFile: hasAtmTransmission(p)};
  }

  // ------------------------------------------------------------------
  // palettes
  // ------------------------------------------------------------------

  const PALETTE_STOPS = {
    'iron': [[0, 0, 0, 0], [0.13, 26, 0, 79], [0.28, 89, 0, 130], [0.42, 155, 15, 120],
      [0.55, 208, 47, 74], [0.68, 238, 105, 19], [0.82, 252, 176, 0], [0.93, 255, 230, 92], [1, 255, 255, 255]],
    'rainbow': [[0, 0, 0, 60], [0.15, 0, 0, 200], [0.3, 0, 180, 220], [0.45, 0, 190, 80],
      [0.6, 200, 220, 0], [0.75, 255, 140, 0], [0.9, 230, 20, 20], [1, 255, 255, 255]],
    'white-hot': [[0, 0, 0, 0], [1, 255, 255, 255]],
    'black-hot': [[0, 255, 255, 255], [1, 0, 0, 0]],
    'arctic': [[0, 0, 0, 40], [0.25, 0, 70, 160], [0.5, 90, 175, 215], [0.7, 225, 225, 225],
      [0.85, 255, 190, 60], [1, 255, 90, 0]],
  };

  const PALETTE_LABEL_KEYS = {
    'iron': 'paletteIron',
    'rainbow': 'paletteRainbow',
    'white-hot': 'paletteWhiteHot',
    'black-hot': 'paletteBlackHot',
    'arctic': 'paletteArctic',
  };

  function buildPalette(name) {
    const stops = PALETTE_STOPS[name] || PALETTE_STOPS.iron;
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) {
          a = stops[s];
          b = stops[s + 1];
          break;
        }
      }
      const span = b[0] - a[0];
      const k = span > 0 ? (t - a[0]) / span : 0;
      out[i * 3] = Math.round(a[1] + (b[1] - a[1]) * k);
      out[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * k);
      out[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * k);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // small DOM helpers
  // ------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function option(value, label, selected) {
    return el('option', {value, selected: selected ? true : null, text: label});
  }

  function labelled(text, control) {
    return el('label', {class: 'flir-seq-field'}, [el('span', {text}), control]);
  }

  function formatBytes(t, n) {
    if (!(n > 0)) return t('unknownSize');
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function formatDate(d, tzMinutes) {
    if (!d || isNaN(d.getTime())) return '';
    const p = (n, w) => String(n).padStart(w || 2, '0');
    const s = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) +
      '.' + p(d.getUTCMilliseconds(), 3);
    if (!tzMinutes) return s + ' UTC';
    const sign = tzMinutes < 0 ? '-' : '+';
    const abs = Math.abs(tzMinutes);
    return s + ' UTC' + sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', {href: url, download: name});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ------------------------------------------------------------------
  // the viewer
  // ------------------------------------------------------------------

  function Viewer(mount, rawLink, fileName) {
    this.cfg = config();
    this.t = makeTranslator(this.cfg.lang);
    this.mount = mount;
    this.rawLink = rawLink;
    this.fileName = fileName;
    this.frameIndex = 0;
    this.spots = [];
    this.spotSeq = 0;
    this.paletteName = PALETTE_STOPS[this.cfg.defaultPalette] ? this.cfg.defaultPalette : 'iron';
    this.palette = buildPalette(this.paletteName);
    this.rangeMode = this.cfg.defaultRangeMode;
    this.manualLo = null;
    this.manualHi = null;
    this.view = {scale: 1, tx: 0, ty: 0, fit: 1};
    this.hover = null;
    this.playing = false;
    this.sequenceRawRange = null;
    this.showExtremes = true;
    // {lo, hi} in whatever unit value() returns, or null for "show everything".
    // Kept in absolute terms, not as a fraction of the colour bar, so that a
    // window stays put while stepping through a sequence that rescales.
    this.filter = null;
    this.pixelCache = {index: -1, pixels: null, stats: null};
  }

  Viewer.prototype.mountUI = function () {
    this.root = el('div', {class: 'flir-seq'});
    this.status = el('div', {class: 'flir-seq-status'});
    this.root.append(this.status);
    this.mount.replaceChildren(this.root);
  };

  Viewer.prototype.setStatus = function (text, kind) {
    this.status.className = 'flir-seq-status' + (kind ? ' flir-seq-status-' + kind : '');
    this.status.textContent = text;
    this.status.hidden = !text;
  };

  Viewer.prototype.load = async function () {
    this.mountUI();
    let size = 0;
    try {
      const head = await fetch(this.rawLink, {method: 'HEAD', credentials: 'same-origin'});
      if (head.ok) size = parseInt(head.headers.get('content-length') || '0', 10) || 0;
    } catch (e) {
      // HEAD is only used for the size guard; a failure here is not fatal
    }

    if (size > this.cfg.maxLoadBytes) {
      this.setStatus(this.t('tooLarge', [formatBytes(this.t, size)]), 'error');
      return;
    }
    if (size > this.cfg.maxAutoLoadBytes) {
      await this.confirmLoad(size);
      return;
    }
    await this.fetchAndRender();
  };

  Viewer.prototype.confirmLoad = function (size) {
    return new Promise((resolve) => {
      const button = el('button', {class: 'ui tiny primary button', type: 'button', text: this.t('loadAnyway')});
      this.setStatus(this.t('confirmLoad', [formatBytes(this.t, size)]));
      this.root.append(el('div', {class: 'flir-seq-confirm'}, [button]));
      button.addEventListener('click', async () => {
        button.parentElement.remove();
        await this.fetchAndRender();
        resolve();
      });
    });
  };

  Viewer.prototype.fetchAndRender = async function () {
    this.setStatus(this.t('downloading', [this.fileName]));
    let buffer;
    try {
      const resp = await fetch(this.rawLink, {credentials: 'same-origin'});
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      buffer = await resp.arrayBuffer();
    } catch (e) {
      this.setStatus(this.t('downloadFailed', [e.message]), 'error');
      return;
    }

    this.setStatus(this.t('parsing'));
    let parsed;
    try {
      parsed = parseSeq(buffer);
    } catch (e) {
      this.setStatus(this.t('parseFailed', [e.message]), 'error');
      return;
    }
    if (!parsed.frames.length) {
      this.setStatus(this.t('notFlir'), 'error');
      return;
    }

    this.buffer = buffer;
    this.frames = parsed.frames;
    this.warnings = parsed.warnings;
    this.frameIndex = 0;
    this.params = paramsFromInfo(this.frames[0].info);
    this.originalParams = Object.assign({}, this.params);
    this.converter = makeConverter(this.params);

    this.buildUI();
    this.selectFrame(0, true);
  };

  // ---------------- UI construction ----------------

  Viewer.prototype.buildUI = function () {
    const self = this;
    const t = this.t;
    const multi = this.frames.length > 1;

    this.imgCanvas = document.createElement('canvas');
    this.viewCanvas = el('canvas', {class: 'flir-seq-canvas'});
    this.barCanvas = el('canvas', {class: 'flir-seq-colorbar-canvas', width: 16, height: 256});

    // --- toolbar -------------------------------------------------
    this.paletteSelect = el('select', {class: 'flir-seq-select'},
      Object.keys(PALETTE_STOPS).map((k) => option(k, t(PALETTE_LABEL_KEYS[k]), k === this.paletteName)));
    this.paletteSelect.addEventListener('change', () => {
      self.paletteName = self.paletteSelect.value;
      self.palette = buildPalette(self.paletteName);
      self.paint();
    });

    this.rangeSelect = el('select', {class: 'flir-seq-select'}, [
      option('frame', t('scaleFrame'), this.rangeMode === 'frame'),
      option('sequence', t('scaleSequence'), this.rangeMode === 'sequence'),
      option('manual', t('scaleManual'), this.rangeMode === 'manual'),
    ]);
    this.rangeSelect.addEventListener('change', () => {
      self.rangeMode = self.rangeSelect.value;
      if (self.rangeMode === 'manual' && self.manualLo === null) {
        self.manualLo = self.rangeLo;
        self.manualHi = self.rangeHi;
        self.manualLoInput.value = self.manualLo.toFixed(self.cfg.decimals);
        self.manualHiInput.value = self.manualHi.toFixed(self.cfg.decimals);
      }
      self.syncRangeInputs();
      self.paint();
    });

    const onManual = () => {
      const lo = parseFloat(self.manualLoInput.value);
      const hi = parseFloat(self.manualHiInput.value);
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        self.manualLo = lo;
        self.manualHi = hi;
        self.paint();
      }
    };
    this.manualLoInput = el('input', {class: 'flir-seq-number', type: 'number', step: '0.1'});
    this.manualHiInput = el('input', {class: 'flir-seq-number', type: 'number', step: '0.1'});
    this.manualLoInput.addEventListener('change', onManual);
    this.manualHiInput.addEventListener('change', onManual);
    this.manualFields = el('span', {class: 'flir-seq-manual'}, [
      labelled(t('scaleMin'), this.manualLoInput), labelled(t('scaleMax'), this.manualHiInput),
    ]);

    this.extremesToggle = el('input', {type: 'checkbox', checked: this.showExtremes ? true : null});
    this.extremesToggle.addEventListener('change', () => {
      self.showExtremes = self.extremesToggle.checked;
      self.paintView();
    });

    const zoomOut = el('button', {class: 'flir-seq-btn', type: 'button', title: t('zoomOut'), text: '−'});
    const zoomIn = el('button', {class: 'flir-seq-btn', type: 'button', title: t('zoomIn'), text: '+'});
    const zoomReset = el('button', {class: 'flir-seq-btn', type: 'button', title: t('zoomFit'), text: '⤢'});
    zoomOut.addEventListener('click', () => self.zoomBy(1 / 1.4));
    zoomIn.addEventListener('click', () => self.zoomBy(1.4));
    zoomReset.addEventListener('click', () => {
      self.fitView();
      self.paintView();
    });

    this.filterReset = el('button',
      {class: 'flir-seq-btn flir-seq-filter-reset', type: 'button', text: t('filterReset'), disabled: true});
    this.filterReset.addEventListener('click', () => {
      self.filter = null;
      self.paint();
    });

    this.toolbar = el('div', {class: 'flir-seq-toolbar'}, [
      labelled(t('palette'), this.paletteSelect),
      labelled(t('scale'), this.rangeSelect),
      this.manualFields,
      labelled(t('extremes'), this.extremesToggle),
      this.filterReset,
      el('span', {class: 'flir-seq-spacer'}),
      el('span', {class: 'flir-seq-zoom'}, [zoomOut, zoomIn, zoomReset]),
    ]);

    // --- canvas + colour bar ------------------------------------
    this.canvasWrap = el('div', {class: 'flir-seq-canvas-wrap'}, [this.viewCanvas]);
    this.barHi = el('span', {class: 'flir-seq-colorbar-label'});
    this.barLo = el('span', {class: 'flir-seq-colorbar-label'});
    this.barMaskHi = el('div', {class: 'flir-seq-colorbar-mask'});
    this.barMaskLo = el('div', {class: 'flir-seq-colorbar-mask'});
    this.handleHi = this.buildHandle('hi');
    this.handleLo = this.buildHandle('lo');
    this.barTrack = el('div', {class: 'flir-seq-colorbar-track'},
      [this.barCanvas, this.barMaskHi, this.barMaskLo, this.handleHi.root, this.handleLo.root]);
    this.colorbar = el('div', {class: 'flir-seq-colorbar'}, [this.barHi, this.barTrack, this.barLo]);
    this.stage = el('div', {class: 'flir-seq-stage'}, [this.canvasWrap, this.colorbar]);

    // --- readout -------------------------------------------------
    this.readout = el('div', {class: 'flir-seq-readout'});

    // --- frame controls -----------------------------------------
    this.frameSlider = el('input', {
      class: 'flir-seq-slider', type: 'range', min: 0, max: this.frames.length - 1, value: 0, step: 1,
    });
    this.frameSlider.addEventListener('input', () => {
      self.stop();
      self.selectFrame(parseInt(self.frameSlider.value, 10));
    });
    this.playButton = el('button', {class: 'flir-seq-btn', type: 'button', text: '▶ ' + t('play')});
    this.playButton.addEventListener('click', () => (self.playing ? self.stop() : self.play()));
    const prev = el('button', {class: 'flir-seq-btn', type: 'button', title: t('prevFrame'), text: '◀'});
    const next = el('button', {class: 'flir-seq-btn', type: 'button', title: t('nextFrame'), text: '▶'});
    prev.addEventListener('click', () => {
      self.stop();
      self.selectFrame(self.frameIndex - 1);
    });
    next.addEventListener('click', () => {
      self.stop();
      self.selectFrame(self.frameIndex + 1);
    });
    this.frameLabel = el('span', {class: 'flir-seq-frame-label'});
    this.frameBar = el('div', {class: 'flir-seq-frames'}, multi
      ? [prev, this.playButton, next, this.frameSlider, this.frameLabel]
      : [this.frameLabel]);

    // --- panels ---------------------------------------------------
    this.spotBody = el('tbody');
    const clearSpots = el('button', {class: 'flir-seq-btn', type: 'button', text: t('clearAll')});
    clearSpots.addEventListener('click', () => {
      self.spots = [];
      self.refreshSpots();
      self.paintView();
    });
    this.spotPanel = el('details', {class: 'flir-seq-panel', open: true}, [
      el('summary', {text: t('spots')}),
      el('div', {class: 'flir-seq-panel-body'}, [
        el('p', {class: 'flir-seq-hint', text: t('spotsHint')}),
        el('table', {class: 'flir-seq-table'}, [
          el('thead', null, el('tr', null, [
            el('th', {text: '#'}), el('th', {text: t('colX')}), el('th', {text: t('colY')}),
            el('th', {text: t('colRaw')}), el('th', {text: t('colTemp')}), el('th', {text: ''}),
          ])),
          this.spotBody,
        ]),
        el('div', {class: 'flir-seq-panel-actions'}, [clearSpots]),
      ]),
    ]);

    this.paramPanel = this.buildParamPanel();
    this.metaPanel = el('details', {class: 'flir-seq-panel'}, [
      el('summary', {text: t('fileInfo')}),
      el('div', {class: 'flir-seq-panel-body'}, [(this.metaBody = el('div', {class: 'flir-seq-meta'}))]),
    ]);

    const exportPng = el('button', {class: 'flir-seq-btn', type: 'button', text: t('exportPng')});
    const exportCsv = el('button', {class: 'flir-seq-btn', type: 'button', text: t('exportCsv')});
    exportPng.addEventListener('click', () => self.exportPng());
    exportCsv.addEventListener('click', () => self.exportCsv());
    this.actions = el('div', {class: 'flir-seq-actions'}, [exportPng, exportCsv]);

    this.root.append(this.toolbar, this.stage, this.readout, this.frameBar,
      el('div', {class: 'flir-seq-panels'}, [this.spotPanel, this.paramPanel, this.metaPanel]), this.actions);

    this.bindCanvas();
    this.updateReadout(null);
    this.syncRangeInputs();
    this.fillMeta();
    this.observeResize();

  };

  Viewer.prototype.buildParamPanel = function () {
    const self = this;
    const t = this.t;
    // [parameter, input step, min, max] -- the label key is the parameter name
    const fields = [
      ['emissivity', 0.01, 0.01, 1],
      ['reflectedTemp', 0.1],
      ['objectDistance', 0.1, 0],
      ['relativeHumidity', 1, 0, 100],
      ['atmTransmission', 0.01, 0, 1],
      ['atmosphericTemp', 0.1],
      ['irWindowTemp', 0.1],
      ['irWindowTransmission', 0.01, 0.01, 1],
    ];
    this.paramInputs = {};
    const controls = fields.map((f) => {
      const input = el('input', {
        class: 'flir-seq-number', type: 'number', step: f[1],
        min: f[2] === undefined ? null : f[2], max: f[3] === undefined ? null : f[3],
      });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!isFinite(v)) {
          input.value = self.params[f[0]];
          return;
        }
        self.params[f[0]] = v;
        self.applyParams();
      });
      this.paramInputs[f[0]] = input;
      return labelled(t(f[0]), input);
    });

    const reset = el('button', {class: 'flir-seq-btn', type: 'button', text: t('resetParams')});
    reset.addEventListener('click', () => {
      self.params = Object.assign({}, self.originalParams);
      self.applyParams();
    });

    this.tauNote = el('p', {class: 'flir-seq-hint'});
    this.paramNote = el('p', {class: 'flir-seq-hint'});
    return el('details', {class: 'flir-seq-panel'}, [
      el('summary', {text: t('params')}),
      el('div', {class: 'flir-seq-panel-body'}, [
        el('div', {class: 'flir-seq-form'}, controls),
        this.tauNote,
        this.paramNote,
        el('div', {class: 'flir-seq-panel-actions'}, [reset]),
      ]),
    ]);
  };

  Viewer.prototype.applyParams = function () {
    // Only the conversion changes here. The cached raw counts and their
    // extremes are properties of the sensor data, so they stay valid.
    this.converter = makeConverter(this.params);
    this.syncParamInputs();
    this.paint();
  };

  Viewer.prototype.syncParamInputs = function () {
    for (const key of Object.keys(this.paramInputs)) {
      const v = this.params[key];
      this.paramInputs[key].value = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }
    // "from the file" only while the value still is the camera's own
    let tauSource = 'tauEstimated';
    if (this.converter.tauFromFile) {
      tauSource = this.params.atmTransmission === this.originalParams.atmTransmission
        ? 'tauFromFile' : 'tauManual';
    }
    this.tauNote.textContent = this.converter.ok
      ? this.t('tauNote', [this.converter.tau.toFixed(4), this.t(tauSource)])
      : '';
    this.paramNote.textContent = this.converter.ok
      ? this.t('planckNote', [
        this.params.planckR1.toFixed(2), this.params.planckR2.toPrecision(6),
        this.params.planckB.toFixed(2), this.params.planckF, this.params.planckO,
      ])
      : this.t(this.converter.reason);
  };

  /**
   * One draggable limit on the colour bar. It is a real slider as far as the
   * browser is concerned -- focusable, arrow-key operable and announced with
   * its temperature -- because the pointer alone makes it unusable without a
   * mouse and impossible to set precisely.
   */
  Viewer.prototype.buildHandle = function (edge) {
    const self = this;
    const label = el('span', {class: 'flir-seq-colorbar-handle-label'});
    const root = el('div', {
      class: 'flir-seq-colorbar-handle flir-seq-colorbar-handle-' + edge,
      role: 'slider', tabindex: 0,
      'aria-label': this.t(edge === 'hi' ? 'filterHigh' : 'filterLow'),
    }, [label]);
    const handle = {root, label, edge};

    const valueAt = (clientY) => {
      const rect = self.barTrack.getBoundingClientRect();
      if (!rect.height) return null;
      const t = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      return self.rangeHi - t * (self.rangeHi - self.rangeLo); // the bar runs hot to cold
    };

    let dragging = false;
    root.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dragging = true;
      root.setPointerCapture(ev.pointerId);
      root.focus();
    });
    root.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const v = valueAt(ev.clientY);
      if (v !== null) self.moveFilterEdge(edge, v);
    });
    const stop = (ev) => {
      dragging = false;
      try {
        root.releasePointerCapture(ev.pointerId);
      } catch (e) {
        // already released
      }
    };
    root.addEventListener('pointerup', stop);
    root.addEventListener('pointercancel', stop);

    root.addEventListener('keydown', (ev) => {
      const span = self.rangeHi - self.rangeLo;
      const step = (ev.shiftKey ? 0.1 : 0.01) * span;
      const filter = self.filterBounds();
      let next = null;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') next = filter[edge] + step;
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') next = filter[edge] - step;
      else if (ev.key === 'Home') next = self.rangeHi;
      else if (ev.key === 'End') next = self.rangeLo;
      else if (ev.key === 'Escape') {
        self.filter = null;
        self.paint();
        ev.preventDefault();
        return;
      }
      if (next === null) return;
      ev.preventDefault();
      self.moveFilterEdge(edge, next);
    });

    return handle;
  };

  /** The window in effect, falling back to the whole colour bar. */
  Viewer.prototype.filterBounds = function () {
    return this.filter || {lo: this.rangeLo, hi: this.rangeHi};
  };

  Viewer.prototype.moveFilterEdge = function (edge, value) {
    const bounds = this.filterBounds();
    const lo = Math.min(this.rangeLo, bounds.lo);
    const hi = Math.max(this.rangeHi, bounds.hi);
    const clamped = Math.min(hi, Math.max(lo, value));
    const next = edge === 'hi'
      ? {lo: Math.min(bounds.lo, clamped), hi: clamped}
      : {lo: clamped, hi: Math.max(bounds.hi, clamped)};
    // dragged back out to both ends: that is how the filter is switched off
    this.filter = next.lo <= this.rangeLo && next.hi >= this.rangeHi ? null : next;
    this.scheduleRepaint();
  };

  /** Coalesce repaints so a drag does not queue one per pointer event. */
  Viewer.prototype.scheduleRepaint = function () {
    if (this.repaintPending) return;
    this.repaintPending = true;
    const run = () => {
      this.repaintPending = false;
      this.paint();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  };

  Viewer.prototype.updateFilterUI = function () {
    const span = this.rangeHi - this.rangeLo;
    const bounds = this.filterBounds();
    const position = (v) => Math.min(100, Math.max(0, (1 - (v - this.rangeLo) / span) * 100));
    const topHi = position(bounds.hi);
    const topLo = position(bounds.lo);

    this.handleHi.root.style.top = topHi + '%';
    this.handleLo.root.style.top = topLo + '%';
    this.handleHi.label.textContent = this.formatScale(bounds.hi);
    this.handleLo.label.textContent = this.formatScale(bounds.lo);
    this.barMaskHi.style.height = topHi + '%';
    this.barMaskLo.style.height = (100 - topLo) + '%';

    for (const handle of [this.handleHi, this.handleLo]) {
      handle.root.setAttribute('aria-valuemin', this.rangeLo.toFixed(this.cfg.decimals));
      handle.root.setAttribute('aria-valuemax', this.rangeHi.toFixed(this.cfg.decimals));
      handle.root.setAttribute('aria-valuenow', bounds[handle.edge].toFixed(this.cfg.decimals));
      handle.root.setAttribute('aria-valuetext', this.formatScale(bounds[handle.edge]));
    }
    this.colorbar.classList.toggle('flir-seq-colorbar-filtered', Boolean(this.filter));
    this.filterReset.disabled = !this.filter;
  };

  Viewer.prototype.syncRangeInputs = function () {
    this.manualFields.hidden = this.rangeMode !== 'manual';
  };

  // ---------------- frames ----------------

  Viewer.prototype.selectFrame = function (index, force) {
    const clamped = Math.max(0, Math.min(this.frames.length - 1, index));
    if (clamped === this.frameIndex && !force) return;
    this.frameIndex = clamped;
    this.frameSlider.value = String(clamped);
    this.paint();
  };

  Viewer.prototype.play = function () {
    if (this.frames.length < 2) return;
    this.playing = true;
    this.playButton.textContent = '⏸ ' + this.t('pause');
    const period = 1000 / Math.max(1, this.cfg.playbackFps);
    this.timer = setInterval(() => {
      this.selectFrame((this.frameIndex + 1) % this.frames.length, true);
    }, period);
  };

  Viewer.prototype.stop = function () {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.playButton) this.playButton.textContent = '▶ ' + this.t('play');
  };

  Viewer.prototype.currentFrame = function () {
    return this.frames[this.frameIndex];
  };

  Viewer.prototype.decode = function () {
    const frame = this.currentFrame();
    if (this.pixelCache.index === this.frameIndex && this.pixelCache.pixels && this.pixelCache.stats) {
      return this.pixelCache;
    }
    const pixels = readFramePixels(this.buffer, frame);
    let stats = null;
    if (pixels) {
      let min = 0xffff, max = 0, minAt = 0, maxAt = 0;
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v < min) {
          min = v;
          minAt = i;
        }
        if (v > max) {
          max = v;
          maxAt = i;
        }
      }
      stats = {min, max, minAt, maxAt};
    }
    this.pixelCache = {index: this.frameIndex, pixels, stats};
    return this.pixelCache;
  };

  /** Raw counts covering the whole sequence, scanned once and cached. */
  Viewer.prototype.sequenceRange = function () {
    if (this.sequenceRawRange) return this.sequenceRawRange;
    let min = 0xffff, max = 0;
    for (const frame of this.frames) {
      const pixels = readFramePixels(this.buffer, frame);
      if (!pixels) continue;
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    this.sequenceRawRange = max >= min ? {min, max} : {min: 0, max: 65535};
    return this.sequenceRawRange;
  };

  // ---------------- values and painting ----------------

  Viewer.prototype.value = function (raw) {
    return this.converter.ok ? this.converter.lut[raw] : raw;
  };

  Viewer.prototype.formatValue = function (raw) {
    const v = this.value(raw);
    if (!isFinite(v)) return '—';
    return this.converter.ok ? v.toFixed(this.cfg.decimals) + ' °C' : this.t('rawUnit', [v]);
  };

  Viewer.prototype.computeRange = function () {
    const stats = this.decode().stats;
    if (!stats) return {lo: 0, hi: 1};
    let lo, hi;
    if (this.rangeMode === 'manual' && this.manualLo !== null) {
      lo = this.manualLo;
      hi = this.manualHi;
    } else if (this.rangeMode === 'sequence') {
      const r = this.sequenceRange();
      lo = this.value(r.min);
      hi = this.value(r.max);
    } else {
      lo = this.value(stats.min);
      hi = this.value(stats.max);
    }
    if (!isFinite(lo) || !isFinite(hi)) {
      lo = stats.min;
      hi = stats.max;
    }
    if (!(hi > lo)) hi = lo + 0.001;
    return {lo, hi};
  };

  Viewer.prototype.paint = function () {
    const frame = this.currentFrame();
    const cache = this.decode();

    this.frameLabel.textContent = (this.frames.length > 1
      ? this.t('frameLabel', [this.frameIndex + 1, this.frames.length])
      : this.t('singleFrame')) + this.frameTime(frame);

    if (!cache.pixels) {
      this.setStatus(frame.error ? this.t(frame.error.key, frame.error.args) : this.t('frameUndecodable'), 'error');
      return;
    }
    // clears an error left behind by a broken frame the user has moved off
    this.setStatus(this.warnings.map((w) => this.t(w.key, w.args)).join(' · '),
      this.warnings.length ? 'warn' : '');

    const range = this.computeRange();
    this.rangeLo = range.lo;
    this.rangeHi = range.hi;

    // raw count -> palette index and opacity, rebuilt whenever the range, the
    // parameters or the limit handles change. Temperature is monotonic in the
    // raw count, so a window on temperature is exact as a window on raw here.
    const idx = new Uint8Array(65536);
    const alpha = new Uint8Array(65536);
    const span = range.hi - range.lo;
    const filter = this.filter;
    for (let raw = 0; raw < 65536; raw++) {
      const v = this.value(raw);
      if (!isFinite(v)) {
        idx[raw] = 0;
        alpha[raw] = 0;
        continue;
      }
      const k = Math.round((v - range.lo) / span * 255);
      idx[raw] = k < 0 ? 0 : (k > 255 ? 255 : k);
      alpha[raw] = !filter || (v >= filter.lo && v <= filter.hi) ? 255 : 0;
    }

    const {width, height} = frame.raw;
    this.imgCanvas.width = width;
    this.imgCanvas.height = height;
    const ctx = this.imgCanvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const data = image.data;
    const pal = this.palette;
    const pixels = cache.pixels;
    // the extremes markers must point at pixels that are actually drawn, so
    // they are tracked over what survives the filter rather than the frame
    let visMin = 0xffff, visMax = -1, visMinAt = 0, visMaxAt = 0;
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      const raw = pixels[i];
      const a = alpha[raw];
      data[o + 3] = a;
      if (!a) continue; // left fully transparent: the background shows through
      const c = idx[raw] * 3;
      data[o] = pal[c];
      data[o + 1] = pal[c + 1];
      data[o + 2] = pal[c + 2];
      if (raw < visMin) {
        visMin = raw;
        visMinAt = i;
      }
      if (raw > visMax) {
        visMax = raw;
        visMaxAt = i;
      }
    }
    ctx.putImageData(image, 0, 0);
    this.visibleStats = visMax < 0 ? null
      : {min: visMin, max: visMax, minAt: visMinAt, maxAt: visMaxAt};

    this.layout();
    this.paintColorbar();
    this.updateFilterUI();
    this.paintView();
    this.refreshSpots();
  };

  Viewer.prototype.frameTime = function (frame) {
    const info = frame.info;
    if (!info || !info.dateTime) return '';
    return ' · ' + formatDate(info.dateTime, info.dateTimeOffsetMinutes);
  };

  Viewer.prototype.paintColorbar = function () {
    const ctx = this.barCanvas.getContext('2d');
    const image = ctx.createImageData(1, 256);
    for (let y = 0; y < 256; y++) {
      const c = (255 - y) * 3;
      const o = y * 4;
      image.data[o] = this.palette[c];
      image.data[o + 1] = this.palette[c + 1];
      image.data[o + 2] = this.palette[c + 2];
      image.data[o + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = 1;
    tmp.height = 256;
    tmp.getContext('2d').putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 16, 256);
    ctx.drawImage(tmp, 0, 0, 16, 256);
    this.barHi.textContent = this.formatScale(this.rangeHi);
    this.barLo.textContent = this.formatScale(this.rangeLo);
  };

  Viewer.prototype.formatScale = function (v) {
    return this.converter.ok ? v.toFixed(this.cfg.decimals) + '°C' : String(Math.round(v));
  };

  Viewer.prototype.layout = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const w = Math.max(120, this.canvasWrap.clientWidth || 640);
    const aspect = frame.raw.height / frame.raw.width;
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 900) * this.cfg.maxHeightVh;
    const h = Math.max(160, Math.min(w * aspect, maxH));
    this.canvasWrap.style.height = h + 'px';
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr;
    this.viewCanvas.width = Math.round(w * dpr);
    this.viewCanvas.height = Math.round(h * dpr);
    this.viewCanvas.style.width = w + 'px';
    this.viewCanvas.style.height = h + 'px';
    const fit = Math.min(w / frame.raw.width, h / frame.raw.height);
    const refit = !this.view.fit || Math.abs(this.view.scale - this.view.fit) < 1e-6;
    this.view.fit = fit;
    if (refit) this.fitView();
    else this.clampView();
  };

  Viewer.prototype.fitView = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    this.view.scale = this.view.fit;
    this.view.tx = (this.viewW - frame.raw.width * this.view.fit) / 2;
    this.view.ty = (this.viewH - frame.raw.height * this.view.fit) / 2;
  };

  Viewer.prototype.clampView = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const w = frame.raw.width * this.view.scale;
    const h = frame.raw.height * this.view.scale;
    this.view.tx = w <= this.viewW ? (this.viewW - w) / 2 : Math.min(0, Math.max(this.viewW - w, this.view.tx));
    this.view.ty = h <= this.viewH ? (this.viewH - h) / 2 : Math.min(0, Math.max(this.viewH - h, this.view.ty));
  };

  Viewer.prototype.zoomBy = function (factor, cx, cy) {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const before = this.view.scale;
    const next = Math.max(this.view.fit, Math.min(this.view.fit * 40, before * factor));
    if (next === before) return;
    const px = cx === undefined ? this.viewW / 2 : cx;
    const py = cy === undefined ? this.viewH / 2 : cy;
    // keep the point under the cursor fixed
    this.view.tx = px - (px - this.view.tx) * (next / before);
    this.view.ty = py - (py - this.view.ty) * (next / before);
    this.view.scale = next;
    this.clampView();
    this.paintView();
  };

  Viewer.prototype.toImage = function (vx, vy) {
    return {
      x: (vx - this.view.tx) / this.view.scale,
      y: (vy - this.view.ty) / this.view.scale,
    };
  };

  Viewer.prototype.toView = function (ix, iy) {
    return {
      x: ix * this.view.scale + this.view.tx,
      y: iy * this.view.scale + this.view.ty,
    };
  };

  Viewer.prototype.rawAt = function (x, y) {
    const frame = this.currentFrame();
    const cache = this.pixelCache;
    if (!frame.raw || !cache.pixels) return null;
    if (x < 0 || y < 0 || x >= frame.raw.width || y >= frame.raw.height) return null;
    return cache.pixels[y * frame.raw.width + x];
  };

  Viewer.prototype.paintView = function () {
    const frame = this.currentFrame();
    if (!frame.raw || !this.viewW) return;
    const ctx = this.viewCanvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.imageSmoothingEnabled = this.view.scale < 1;
    ctx.drawImage(this.imgCanvas, this.view.tx, this.view.ty,
      frame.raw.width * this.view.scale, frame.raw.height * this.view.scale);

    this.drawMarkers(ctx, frame);

    if (this.hover) {
      const p = this.toView(this.hover.x + 0.5, this.hover.y + 0.5);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, Math.max(0, p.y - 12));
      ctx.lineTo(p.x, Math.min(this.viewH, p.y + 12));
      ctx.moveTo(Math.max(0, p.x - 12), p.y);
      ctx.lineTo(Math.min(this.viewW, p.x + 12), p.y);
      ctx.stroke();
      ctx.restore();
    }
  };

  /** The extremes and the spot meters, in image coordinates. */
  Viewer.prototype.drawMarkers = function (ctx, frame) {
    const stats = this.visibleStats;
    if (this.showExtremes && stats) {
      const w = frame.raw.width;
      this.drawMarker(ctx, (stats.maxAt % w) + 0.5, Math.floor(stats.maxAt / w) + 0.5, '#ff2d2d',
        this.t('hottest', [this.formatValue(stats.max)]));
      this.drawMarker(ctx, (stats.minAt % w) + 0.5, Math.floor(stats.minAt / w) + 0.5, '#3da5ff',
        this.t('coldest', [this.formatValue(stats.min)]));
    }
    this.spots.forEach((spot, i) => {
      const raw = this.rawAt(spot.x, spot.y);
      this.drawMarker(ctx, spot.x + 0.5, spot.y + 0.5, '#ffffff',
        '#' + (i + 1) + ' ' + (raw === null ? '—' : this.formatValue(raw)));
    });
  };

  Viewer.prototype.drawMarker = function (ctx, ix, iy, colour, label) {
    const p = this.toView(ix, iy);
    if (p.x < -20 || p.y < -20 || p.x > this.viewW + 20 || p.y > this.viewH + 20) return;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(p.x - 7, p.y);
    ctx.lineTo(p.x + 7, p.y);
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x, p.y + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    if (label) {
      ctx.font = '11px system-ui, sans-serif';
      const width = ctx.measureText(label).width + 6;
      let lx = p.x + 10;
      if (lx + width > this.viewW) lx = p.x - 10 - width;
      const ly = Math.max(12, Math.min(this.viewH - 4, p.y - 8));
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(lx, ly - 11, width, 14);
      ctx.fillStyle = colour;
      ctx.fillText(label, lx + 3, ly);
    }
    ctx.restore();
  };

  // ---------------- interaction ----------------

  Viewer.prototype.bindCanvas = function () {
    const self = this;
    const canvas = this.viewCanvas;
    let pointerId = null, dragging = false, moved = 0, lastX = 0, lastY = 0;

    const local = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return {x: ev.clientX - rect.left, y: ev.clientY - rect.top};
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      pointerId = ev.pointerId;
      dragging = true;
      moved = 0;
      const p = local(ev);
      lastX = p.x;
      lastY = p.y;
      canvas.setPointerCapture(pointerId);
    });

    canvas.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      if (dragging && ev.pointerId === pointerId) {
        moved += Math.abs(p.x - lastX) + Math.abs(p.y - lastY);
        self.view.tx += p.x - lastX;
        self.view.ty += p.y - lastY;
        lastX = p.x;
        lastY = p.y;
        self.clampView();
        self.paintView();
        return;
      }
      self.updateHover(p.x, p.y);
    });

    const endDrag = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const p = local(ev);
      if (moved < 4) self.addSpotAt(p.x, p.y);
      dragging = false;
      pointerId = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (e) {
        // the capture is already gone, nothing to release
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', (ev) => {
      dragging = false;
      pointerId = null;
      void ev;
    });

    canvas.addEventListener('pointerleave', () => {
      self.hover = null;
      self.updateReadout(null);
      self.paintView();
    });

    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = local(ev);
      self.zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
      self.updateHover(p.x, p.y);
    }, {passive: false});

    canvas.addEventListener('dblclick', () => {
      self.fitView();
      self.paintView();
    });
  };

  Viewer.prototype.updateHover = function (vx, vy) {
    const img = this.toImage(vx, vy);
    const x = Math.floor(img.x);
    const y = Math.floor(img.y);
    const raw = this.rawAt(x, y);
    this.hover = raw === null ? null : {x, y};
    this.updateReadout(raw === null ? null : {x, y, raw});
    this.paintView();
  };

  Viewer.prototype.addSpotAt = function (vx, vy) {
    const img = this.toImage(vx, vy);
    const x = Math.floor(img.x);
    const y = Math.floor(img.y);
    if (this.rawAt(x, y) === null) return;
    this.spots.push({x, y, id: ++this.spotSeq});
    this.refreshSpots();
    this.paintView();
  };

  Viewer.prototype.updateReadout = function (hit) {
    if (!hit) {
      this.readout.textContent = this.t('readoutHint');
      this.readout.classList.remove('flir-seq-readout-live');
      return;
    }
    this.readout.classList.add('flir-seq-readout-live');
    this.readout.textContent = this.t('readout',
      [hit.x, hit.y, this.formatValue(hit.raw), this.t('readoutRaw', [hit.raw])]);
  };

  Viewer.prototype.refreshSpots = function () {
    const self = this;
    this.spotBody.replaceChildren();
    if (!this.spots.length) {
      this.spotBody.append(el('tr', null, el('td', {colspan: 6, class: 'flir-seq-empty', text: this.t('noSpots')})));
      return;
    }
    this.spots.forEach((spot, i) => {
      const raw = this.rawAt(spot.x, spot.y);
      const remove = el('button', {class: 'flir-seq-btn flir-seq-btn-mini', type: 'button', text: this.t('delete')});
      remove.addEventListener('click', () => {
        self.spots.splice(i, 1);
        self.refreshSpots();
        self.paintView();
      });
      this.spotBody.append(el('tr', null, [
        el('td', {text: '#' + (i + 1)}),
        el('td', {text: String(spot.x)}),
        el('td', {text: String(spot.y)}),
        el('td', {text: raw === null ? '—' : String(raw)}),
        el('td', {class: 'flir-seq-temp', text: raw === null ? '—' : this.formatValue(raw)}),
        el('td', null, remove),
      ]));
    });
  };

  Viewer.prototype.fillMeta = function () {
    const info = this.frames[0].info || {};
    const frame = this.frames[0];
    const t = this.t;
    const rows = [
      [t('metaFile'), this.fileName],
      [t('metaFrames'), String(this.frames.length)],
      [t('metaResolution'), frame.raw ? frame.raw.width + ' × ' + frame.raw.height : t('unknown')],
      [t('metaCamera'), [info.cameraModel, info.cameraPartNumber, info.cameraSerialNumber].filter(Boolean).join(' / ')],
      [t('metaFirmware'), info.cameraSoftware],
      [t('metaLens'), [info.lensModel, info.lensPartNumber].filter(Boolean).join(' / ')],
      [t('metaFov'), isFinite(info.fieldOfView) ? info.fieldOfView.toFixed(2) + '°' : ''],
      [t('metaCaptured'), formatDate(info.dateTime, info.dateTimeOffsetMinutes)],
      [t('metaFrameRate'), info.frameRate ? info.frameRate + ' Hz' : ''],
      [t('metaRange'), isFinite(info.cameraTempRangeMinK) && isFinite(info.cameraTempRangeMaxK)
        ? (info.cameraTempRangeMinK - K0).toFixed(1) + ' … ' + (info.cameraTempRangeMaxK - K0).toFixed(1) + ' °C' : ''],
      [t('metaContainer'), frame.format],
    ];
    if (info.pixelValueType !== undefined &&
        (info.pixelValueType !== VERIFIED_PIXEL_VALUE_TYPE || info.pixelValueUnit)) {
      rows.push([t('metaPixelValues'), info.pixelValueType + ' / ' + info.pixelValueUnit]);
    }
    this.metaBody.replaceChildren();
    for (const [k, v] of rows) {
      if (!v) continue;
      this.metaBody.append(el('div', {class: 'flir-seq-meta-row'}, [
        el('span', {class: 'flir-seq-meta-key', text: k}),
        el('span', {class: 'flir-seq-meta-value', text: v}),
      ]));
    }
  };

  Viewer.prototype.observeResize = function () {
    if (typeof ResizeObserver === 'undefined') return;
    let width = 0;
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.canvasWrap.clientWidth;
      if (!w || w === width) return;
      width = w;
      this.layout();
      this.paintView();
    });
    this.resizeObserver.observe(this.canvasWrap);
  };

  // ---------------- export ----------------

  Viewer.prototype.baseName = function () {
    return this.fileName.replace(/\.[^.]+$/, '') + '-frame' + (this.frameIndex + 1);
  };

  Viewer.prototype.exportPng = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const out = document.createElement('canvas');
    out.width = frame.raw.width;
    out.height = frame.raw.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(this.imgCanvas, 0, 0);

    // markers go through the same helper, at scale 1 and no pan, so the export
    // and the screen cannot drift apart
    const saved = this.view;
    const savedW = this.viewW, savedH = this.viewH;
    this.view = {scale: 1, tx: 0, ty: 0, fit: 1};
    this.viewW = out.width;
    this.viewH = out.height;
    this.drawMarkers(ctx, frame);
    this.view = saved;
    this.viewW = savedW;
    this.viewH = savedH;

    out.toBlob((blob) => blob && download(blob, this.baseName() + '.png'), 'image/png');
  };

  Viewer.prototype.exportCsv = function () {
    const frame = this.currentFrame();
    const pixels = this.pixelCache.pixels;
    if (!frame.raw || !pixels) return;
    const {width, height} = frame.raw;
    const lines = new Array(height);
    const decimals = this.cfg.decimals;
    for (let y = 0; y < height; y++) {
      const row = new Array(width);
      for (let x = 0; x < width; x++) {
        const v = this.value(pixels[y * width + x]);
        row[x] = isFinite(v) ? (this.converter.ok ? v.toFixed(decimals) : String(v)) : '';
      }
      lines[y] = row.join(',');
    }
    const header = '# ' + this.fileName + ' frame ' + (this.frameIndex + 1) + '/' + this.frames.length +
      ', unit=' + (this.converter.ok ? 'degC' : 'raw') +
      ', emissivity=' + this.params.emissivity +
      ', reflected=' + this.params.reflectedTemp +
      ', distance=' + this.params.objectDistance +
      ', humidity=' + this.params.relativeHumidity + '\n';
    download(new Blob([header + lines.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'}),
      this.baseName() + '.csv');
  };

  // ------------------------------------------------------------------
  // wiring into Gitea's file view
  // ------------------------------------------------------------------

  function fileNameOf(rawLink) {
    try {
      const path = new URL(rawLink, 'http://localhost').pathname;
      return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
    } catch (e) {
      return rawLink.substring(rawLink.lastIndexOf('/') + 1);
    }
  }

  function isSupported(name) {
    const lower = name.toLowerCase();
    return config().extensions.some((ext) => lower.endsWith(ext));
  }

  function attach(elFileView) {
    if (elFileView.hasAttribute('data-flir-seq')) return;
    const rawLink = elFileView.getAttribute('data-raw-file-link');
    if (!rawLink) return;
    const name = fileNameOf(rawLink);
    if (!isSupported(name)) return;
    elFileView.setAttribute('data-flir-seq', '1');

    let mount = elFileView.querySelector('.file-view-render-container');
    if (!mount) {
      const fileView = elFileView.querySelector('.file-view');
      if (!fileView) return;
      mount = el('div', {class: 'file-view-render-container'});
      fileView.append(mount);
    }
    mount.classList.add('flir-seq-mount');
    const viewer = new Viewer(mount, rawLink, name);
    // exposed on purpose: contrib/flir-seq/test drives the viewer through it,
    // and it is the handle to reach for when debugging a page in the console
    mount.giteaFlirSeqViewer = viewer;
    viewer.load();
  }

  function scan(root) {
    const nodes = root.querySelectorAll ? root.querySelectorAll('.non-diff-file-content[data-raw-file-link]') : [];
    for (const node of nodes) attach(node);
    if (root.matches && root.matches('.non-diff-file-content[data-raw-file-link]')) attach(root);
  }

  function init(doc) {
    const start = () => {
      scan(doc);
      // Gitea 1.24+ swaps the file view in place when the file tree is used,
      // so a one-shot scan on load is not enough.
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) scan(node);
          }
        }
      });
      observer.observe(doc.body, {childList: true, subtree: true});
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return {
    init,
    parseSeq,
    readFramePixels,
    paramsFromInfo,
    makeConverter,
    planckRaw,
    atmosphericTransmission,
    buildPalette,
    hasAtmTransmission,
    VERIFIED_PIXEL_VALUE_TYPE,
    makeTranslator,
    resolveLang,
    LANGUAGES,
    FALLBACK_LANG,
    DEFAULTS,
  };
});
