/**
 * 정적분 탐구실 — AI 피드백 중계 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 교사 PIN(해시로만 저장)과 Gemini API 키를 '스크립트 속성'에 보관해요. 학생 브라우저에는 절대 보내지 않아요.
 *  - 학생 앱의 요청을 받아 서버에서 Gemini를 호출하고, 결과만 돌려줘요.
 *  - 남용을 막기 위해 분당·하루 사용 횟수 제한, 입력 길이 제한, PIN 5회 오류 시 10분 잠금이 있어요.
 *
 * 배포 방법은 함께 있는 README(설치 안내)를 보세요.
 *  배포 설정: 실행 사용자 = 나,  액세스 권한 = 모든 사용자
 */

const DEFAULTS = {
  model: 'gemini-3.8-flash',
  perMinute: 40,     // 1분에 받을 수 있는 AI 요청 수 (반 전체 합계)
  perDay: 1500,      // 하루 AI 요청 수
};
const DEFAULT_PIN = '1234'; // 처음 한 번만 쓰여요. 로그인 후 반드시 바꾸세요.

const TEACHER_RULES = `당신은 고등학교 미적분을 처음 배우는 학생을 돕는 친절한 한국어 수학 선생님입니다.
학생은 수학 성취 수준이 보통 이하일 수 있습니다. 다음을 반드시 지키세요.
- 정답이나 완성된 설명을 통째로 알려주지 마세요. 학생이 스스로 생각하도록 질문 한 개 또는 작은 실마리 한 개만 주세요.
- 쉬운 말과 짧은 문장을 쓰고, 어려운 기호나 용어(리만 합, 엡실론 등)는 피하세요.
- 학생 답에서 잘한 점을 먼저 구체적으로 칭찬하세요.
- 2~4문장, 150자 내외로 짧게 답하세요. 마크다운 기호는 쓰지 마세요.
- 정적분·넓이·직사각형 탐구와 관계없는 요청(다른 과목 숙제, 잡담, 코드 작성 등)에는 "지금은 정적분 탐구에 집중해 볼까요?"라고만 답하세요.
- 앱 화면에는 함수 그래프, 직사각형(개수 n, 가로 Δx), 직사각형 넓이의 합 S_n이 보입니다. 필요하면 "그래프에서 n을 늘려 보세요" 같이 조작을 권하세요.`;

/* ---------------- 진입점 ---------------- */
function doGet() {
  return json_({ ok: true, service: 'defint', aiEnabled: aiEnabled_() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[req.action];
    if (!handler) return json_({ ok: false, error: '알 수 없는 요청이에요.' });
    return json_(Object.assign({ ok: true }, handler(req)));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  /* 학생용 */
  status: () => ({ aiEnabled: aiEnabled_() }),
  judge:  req => ({ result: judge_(req) }),
  chat:   req => ({ text: chat_(req) }),

  /* 교사용 (로그인 필요) */
  login:  req => login_(req.pin),
  logout: req => { CacheService.getScriptCache().remove('tok_' + req.token); return {}; },
  getConfig:  req => { auth_(req.token); return config_(); },
  saveConfig: req => { auth_(req.token); return saveConfig_(req); },
  listModels: req => { auth_(req.token); return { models: listModels_() }; },
  test:       req => { auth_(req.token); return { text: gemini_([{ role: 'user', parts: [{ text: '"연결 성공"이라고만 답하세요.' }] }], '짧게 답하세요.', false) }; },
};

/* ---------------- 설정 저장소 ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
function getKey_() { return props_().getProperty('GEMINI_API_KEY') || ''; }
function getModel_() { return props_().getProperty('MODEL') || DEFAULTS.model; }
function getNum_(name, def) { const v = Number(props_().getProperty(name)); return v > 0 ? v : def; }
function aiEnabled_() { return !!getKey_() && props_().getProperty('AI_ENABLED') !== 'false'; }

function config_() {
  const key = getKey_();
  return {
    hasKey: !!key,
    keyTail: key ? key.slice(-4) : '',
    model: getModel_(),
    aiEnabled: props_().getProperty('AI_ENABLED') !== 'false',
    perMinute: getNum_('PER_MINUTE', DEFAULTS.perMinute),
    perDay: getNum_('PER_DAY', DEFAULTS.perDay),
    usedToday: Number(props_().getProperty(dayKey_()) || 0),
    mustChangePin: !props_().getProperty('PIN_HASH'),
  };
}

function saveConfig_(req) {
  const p = props_();
  if (typeof req.key === 'string' && req.key.trim()) p.setProperty('GEMINI_API_KEY', req.key.trim());
  if (req.clearKey) p.deleteProperty('GEMINI_API_KEY');
  if (typeof req.model === 'string' && /^[a-z0-9.\-]+$/i.test(req.model)) p.setProperty('MODEL', req.model);
  if (typeof req.aiEnabled === 'boolean') p.setProperty('AI_ENABLED', String(req.aiEnabled));
  if (Number(req.perMinute) > 0) p.setProperty('PER_MINUTE', String(Math.min(300, Math.floor(req.perMinute))));
  if (Number(req.perDay) > 0) p.setProperty('PER_DAY', String(Math.min(20000, Math.floor(req.perDay))));
  if (typeof req.newPin === 'string' && req.newPin) {
    if (req.newPin.length < 4) throw new Error('PIN은 4자리 이상으로 정해 주세요.');
    if (req.newPin === DEFAULT_PIN) throw new Error('처음 설정값(1234)과 다른 PIN으로 정해 주세요.');
    const salt = Utilities.getUuid();
    p.setProperties({ PIN_SALT: salt, PIN_HASH: hash_(salt, req.newPin) });
  }
  return config_();
}

/* ---------------- 교사 로그인 ---------------- */
function hash_(salt, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function login_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= 5) throw new Error('PIN을 여러 번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 시도하세요.');
  const p = props_();
  const saved = p.getProperty('PIN_HASH');
  const ok = saved ? hash_(p.getProperty('PIN_SALT') || '', String(pin || '')) === saved
                   : String(pin || '') === DEFAULT_PIN;
  if (!ok) {
    cache.put('pin_fails', String(fails + 1), 600);
    throw new Error('PIN이 올바르지 않아요.');
  }
  cache.remove('pin_fails');
  const token = Utilities.getUuid();
  cache.put('tok_' + token, '1', 7200); // 2시간 동안 유효
  return { token: token, mustChangePin: !saved };
}

function auth_(token) {
  if (!token || !CacheService.getScriptCache().get('tok_' + token))
    throw new Error('관리자 로그인이 만료됐어요. 다시 로그인해 주세요.');
}

/* ---------------- 사용량 제한 ---------------- */
function dayKey_() { return 'USAGE_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd'); }

function checkQuota_() {
  if (!aiEnabled_()) throw new Error('AI 피드백이 꺼져 있어요.');
  const cache = CacheService.getScriptCache();
  const minuteKey = 'rl_' + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const m = Number(cache.get(minuteKey) || 0);
    if (m >= getNum_('PER_MINUTE', DEFAULTS.perMinute)) throw new Error('지금 요청이 많아요. 1분 뒤에 다시 시도해 주세요.');
    const dk = dayKey_(), p = props_();
    const d = Number(p.getProperty(dk) || 0);
    if (d >= getNum_('PER_DAY', DEFAULTS.perDay)) throw new Error('오늘 사용할 수 있는 AI 횟수를 모두 썼어요.');
    cache.put(minuteKey, String(m + 1), 120);
    p.setProperty(dk, String(d + 1));
  } finally {
    lock.releaseLock();
  }
}

function clip_(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

/* ---------------- AI 기능 ---------------- */
function judge_(req) {
  checkQuota_();
  const rubric = (Array.isArray(req.rubric) ? req.rubric : []).slice(0, 6).map(r => clip_(r, 80)).join(' / ');
  const prompt =
`[탐구 질문] ${clip_(req.question, 300)}
[교사가 기대하는 핵심 생각 - 학생에게 그대로 알려주지 말 것] ${clip_(req.goal, 500)}
[평가 기준] 다음 요소 중 ${Number(req.need) || 1}개 이상이 학생 말로 (표현이 서툴러도) 담겨 있으면 통과: ${rubric}
[이 단계 시도 횟수] ${Number(req.tries) || 1}
[학생 답] ${clip_(req.answer, 800)}

JSON으로만 답하세요: {"pass": true 또는 false, "feedback": "학생에게 줄 피드백"}
- pass가 true면: 잘한 점을 칭찬하고, 더 생각해 볼 점이 있으면 한 가지만 가볍게 덧붙이세요.
- pass가 false면: 잘한 점을 먼저 말하고, 빠진 생각을 정답으로 알려주지 말고 질문 한 개로 이끌어 주세요. 시도 횟수가 3 이상이면 실마리를 조금 더 구체적으로 주세요.`;
  const out = gemini_([{ role: 'user', parts: [{ text: prompt }] }], TEACHER_RULES, true);
  const j = JSON.parse(out.replace(/```json|```/g, '').trim());
  return { pass: !!j.pass, feedback: clip_(j.feedback, 600) };
}

function chat_(req) {
  checkQuota_();
  const hist = (Array.isArray(req.history) ? req.history : []).slice(-10).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: clip_(m.text, 500) }],
  }));
  if (!hist.length || hist[hist.length - 1].role !== 'user') throw new Error('질문이 비어 있어요.');
  const context = clip_(req.context, 600) +
    '\n학생이 탐구 질문의 정답을 직접 물어보면 답을 말하지 말고 생각할 질문으로 되돌려 주세요.';
  return gemini_(hist, TEACHER_RULES + '\n[현재 화면] ' + context, false).trim();
}

function gemini_(contents, system, asJson) {
  const key = getKey_();
  if (!key) throw new Error('API 키가 등록되지 않았어요.');
  const body = { contents: contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature: 0.4 } };
  if (asJson) body.generationConfig.responseMimeType = 'application/json';
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(getModel_()) + ':generateContent',
    { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error((data.error && data.error.message) || ('Gemini 오류 ' + res.getResponseCode()));
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

function listModels_() {
  const key = getKey_();
  if (!key) throw new Error('먼저 API 키를 저장해 주세요.');
  let all = [], tok = '';
  do {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' + (tok ? '&pageToken=' + tok : ''),
      { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
    const d = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200) throw new Error((d.error && d.error.message) || ('HTTP ' + res.getResponseCode()));
    all = all.concat(d.models || []); tok = d.nextPageToken || '';
  } while (tok);
  return all
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
    .filter(m => /^gemini/.test(m.id) && !/(embedding|image|tts|audio|live|vision|aqa|robotics|transcribe|banana)/i.test(m.id));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- (선택) 편집기에서 직접 설정하기 ----------------
 * 앱의 관리자 화면 대신, 아래 값을 채우고 이 함수를 한 번 실행해도 돼요.
 * 실행한 뒤에는 키와 PIN을 지우고 저장하세요. (코드에 남겨 두지 마세요!)
 */
function setupOnce() {
  const API_KEY = '';   // 예: 'AIza...'
  const NEW_PIN = '';   // 예: '7429'
  const p = props_();
  if (API_KEY) p.setProperty('GEMINI_API_KEY', API_KEY);
  if (NEW_PIN) { const salt = Utilities.getUuid(); p.setProperties({ PIN_SALT: salt, PIN_HASH: hash_(salt, NEW_PIN) }); }
  Logger.log('설정 완료: 키 ' + (getKey_() ? '있음' : '없음') + ', PIN ' + (p.getProperty('PIN_HASH') ? '설정됨' : '기본값(1234)'));
}
