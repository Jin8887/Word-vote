/* =========================================================
   핵심가치 선정 · 투표  ―  app.js
   - 운영자(host) / 참여자(voter) 단일 페이지
   - Google Apps Script 웹앱과 연동 (저장 + 실시간 집계)
   - v2 변경: 참여자가 본인이 제안한 후보를 삭제할 수 있도록 기능 추가
     · sessionStorage 기반 익명 voterId로 본인 식별 (동명이인 안전)
     · 새로고침 후에도 본인 제안 목록 유지
     · phase=suggest 단계에서만 삭제 가능 (투표 시작 후 자동 차단)
   - v2.1 변경: 진행자 "직접 추가" 후보도 시트에 저장 + 진행자가 삭제 가능
     · 진행자 전용 식별자(host_<code>)로 본인이 추가한 행만 삭제
     · 참여자가 같은 키워드를 제안하면 진행자 추가는 가려짐(다른 사람도 제안한 후보가 됨)
   - v2.2 변경: 진행자가 화면을 나갔다가 다시 들어와도 세션 자동 복원
     · localStorage(cv_host)에 코드/제목/병합/제외 상태 보존
     · 진행자 모드 진입 시 서버에 phase 확인 → 적절한 화면으로 자동 이동
     · 자동 복원 실패 시(네트워크 오류 등) drawHostRecovery로 사용자 선택 안내
     · 같은 브라우저 한정. 다른 기기/브라우저 재진입은 별도 인증이 필요하므로 미지원
   ※ 본 변경은 GAS Code.gs 측 수정도 필요합니다 (v2 시점에서 이미 완료)
   ========================================================= */

'use strict';

/* ------------------------------------------------------------------
   ⚙️ 설정 :  배포 후 아래 GAS_URL 한 줄만 본인 것으로 교체하세요.
   (GOOGLE_SHEETS_SETUP.md 참고)
------------------------------------------------------------------ */
const GAS_URL = "https://script.google.com/macros/s/AKfycbwOLQ_VOL1ceZQBRMUcL2d2-C1Zg8Tzb_MCP5oRY9pSxiEJte34iXFYqny9AdSCg4XU/exec";

/* 5점 척도 정의 (슬라이드 기준 그대로) */
const SCALE = [
  { n: 1, t: "정합성 없음", d: "비전과 무관" },
  { n: 2, t: "낮음",        d: "연관성 약함" },
  { n: 3, t: "보통",        d: "어느 정도 연결" },
  { n: 4, t: "높음",        d: "비전 실현에 필요" },
  { n: 5, t: "매우 높음",   d: "비전을 가장 잘 대변" },
];

const app    = document.getElementById('app');
const $toast = document.getElementById('toast');
let pollTimer = null;

/* ====================== 유틸 ====================== */
function el(html){ const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstElementChild; }
function esc(s){ return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function toast(msg, ms=2200){ $toast.textContent=msg; $toast.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>$toast.classList.remove('show'),ms); }
function genCode(){ return String(Math.floor(1000 + Math.random()*9000)); }
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
function isConfigured(){ return GAS_URL && !GAS_URL.includes('여기에'); }

/* localStorage 안전 래퍼 (운영자 세션 임시 보관용) */
const store = {
  get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch{ return null; } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
  del(k){ try{ localStorage.removeItem(k); }catch{} },
};

/* sessionStorage 안전 래퍼 (참여자 본인 식별 / 본인 제안 보관용)
   - 같은 탭 내에서만 유지되어, 다른 사람과 격리되는 익명 식별자 보관에 적합 */
const sstore = {
  get(k){ try{ return JSON.parse(sessionStorage.getItem(k)); }catch{ return null; } },
  set(k,v){ try{ sessionStorage.setItem(k, JSON.stringify(v)); }catch{} },
  del(k){ try{ sessionStorage.removeItem(k); }catch{} },
};

/* 참여자 익명 식별자 발급/조회
   - 같은 브라우저 탭 안에서만 동일 ID 유지 (탭 닫으면 소멸)
   - 모든 suggest/removeSuggestion 호출에 동봉 → 본인 제안만 삭제 가능 */
function getVoterId(){
  let id = sstore.get('cv_voter_id');
  if(!id){
    id = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
    sstore.set('cv_voter_id', id);
  }
  return id;
}

/* 참여자 본인 제안 목록 보관 (새로고침 대응)
   - 세션 코드별로 분리 보관 (다른 활동과 섞이지 않도록) */
function saveMySuggestions(code, list){
  sstore.set('cv_my_sugg_' + code, list || []);
}
function loadMySuggestions(code){
  return sstore.get('cv_my_sugg_' + code) || [];
}

/* 진행자 전용 식별자 (localStorage 영구 보관 / 세션 코드별 발급)
   - 진행자가 "직접 추가" 한 후보를 시트에 저장할 때 voterId로 사용
   - 같은 진행자가 같은 세션을 다시 열어도 동일 ID를 유지 → 본인 추가만 삭제 가능 */
function getHostId(){
  if(!HOST || !HOST.code) return 'host_unknown';
  const key = 'cv_host_id_' + HOST.code;
  let id = store.get(key);
  if(!id){
    id = 'host_' + HOST.code + '_' + Date.now().toString(36);
    store.set(key, id);
  }
  return id;
}

/* ====================== 네트워크 (GAS 연동) ====================== */
/* GAS는 CORS 프리플라이트를 피하려고 text/plain POST 사용 */
async function gasPost(action, payload){
  if(!isConfigured()) throw new Error('NOT_CONFIGURED');
  const res = await fetch(GAS_URL, {
    method:'POST',
    headers:{ 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload }),
  });
  if(!res.ok) throw new Error('HTTP_'+res.status);
  const data = await res.json();
  if(!data.ok) throw new Error(data.error || 'SERVER_ERROR');
  return data;
}
async function gasGet(params){
  if(!isConfigured()) throw new Error('NOT_CONFIGURED');
  const url = GAS_URL + '?' + new URLSearchParams(params).toString();
  const res = await fetch(url, { method:'GET' });
  if(!res.ok) throw new Error('HTTP_'+res.status);
  const data = await res.json();
  if(!data.ok) throw new Error(data.error || 'SERVER_ERROR');
  return data;
}

/* ====================== 라우팅 ====================== */
function route(){
  stopPolling();
  const q = new URLSearchParams(location.search);
  const code = q.get('s');         // 참여자 접속용 세션코드
  if(code){ renderVoter(code.trim()); return; }
  renderLanding();
}
window.addEventListener('popstate', route);

/* ====================== 랜딩 ====================== */
function renderLanding(){
  app.innerHTML = '';
  const c = el(`
    <div class="wrap narrow">
      ${!isConfigured() ? `<div class="err-banner">⚠️ 아직 Google Sheets 연동이 설정되지 않았습니다. <b>app.js</b>의 <code>GAS_URL</code>을 입력해야 데이터 저장·실시간 집계가 작동합니다. (설정 전에도 화면 미리보기는 가능)</div>` : ''}
      <div class="card">
        <h2>무엇을 하시겠어요?</h2>
        <p class="sub">진행자는 세션을 만들고, 참여자는 코드로 접속해 투표합니다.</p>
        <div class="landing-grid">
          <div class="mode-card" id="m-host">
            <div class="ic">🧑‍🏫</div>
            <h3>진행자로 시작</h3>
            <p>세션 생성 · 후보 입력 · 실시간 집계</p>
          </div>
          <div class="mode-card" id="m-vote">
            <div class="ic">🙋</div>
            <h3>참여자로 투표</h3>
            <p>세션 코드를 입력하고 투표 참여</p>
          </div>
        </div>
      </div>
    </div>
  `);
  app.appendChild(c);
  c.querySelector('#m-host').onclick = renderHostSetup;
  c.querySelector('#m-vote').onclick = () => renderVoter(null);
}

/* =========================================================
   진행자 (HOST)  ―  실시간 후보 제안 버전
   ========================================================= */
let HOST = null;   // { code, title, candidates?, merges?, excluded? }

/* 진행자 상태를 localStorage에 저장 (병합/제외 등 메타정보 포함)
   - 화면을 나갔다 들어와도 같은 브라우저면 자동 복원 가능 */
function saveHostState(){
  if(!HOST || !HOST.code) return;
  HOST.merges   = HOST_MERGES;
  HOST.excluded = HOST_EXCLUDED;
  store.set('cv_host', HOST);
}

/* 진행자 모드 진입 — v2.2: 진행 중인 세션 자동 복원 지원
   - localStorage에 cv_host가 있고 GAS 연동이 설정되어 있으면 서버에서 phase 확인
   - phase에 맞는 화면으로 자동 이동 (제안중 → drawHostSuggest, 투표중 → drawHostLive)
   - 서버에 세션이 없으면(만료/삭제) cv_host 정리 후 새 세션 화면
   - 네트워크 오류는 사용자에게 "다시 시도/새 세션 만들기" 선택지 제공 */
async function renderHostSetup(){
  stopPolling();
  const saved = store.get('cv_host');

  // 저장된 세션이 없거나 연동 미설정이면 곧장 새 세션 화면
  if(!saved || !saved.code || !isConfigured()){
    HOST = saved || { code:genCode(), title:'' };
    drawHostSetup();
    return;
  }

  // 자동 복원 시도 — 로딩 화면 잠깐 표시
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="wrap narrow">
      <div class="card center" style="padding:2.5rem 1.5rem;">
        <div class="spinner" style="margin:0 auto 1rem;"></div>
        <p style="font-weight:600;">진행 중인 세션을 확인하고 있습니다…</p>
        <p class="muted" style="font-size:.85rem;margin-top:.4rem;">코드 <b>${esc(saved.code)}</b></p>
      </div>
    </div>
  `));

  try{
    const data = await gasGet({ action:'getSession', code:saved.code });
    // 세션 존재 — 적절한 화면으로 복원
    HOST = {
      code: data.code,
      title: data.title || saved.title || '',
      candidates: data.candidates && data.candidates.length ? data.candidates : (saved.candidates||[])
    };
    // 진행자가 작업해둔 병합/제외 메타 복원 (서버엔 없으므로 localStorage에서)
    HOST_MERGES   = saved.merges   || [];
    HOST_EXCLUDED = saved.excluded || {};
    HOST_RAW = []; HOST_SUGG = []; MERGE_PICK = {}; MERGE_MODE = false;

    const phase = data.phase || 'suggest';
    if(phase === 'vote'){
      drawHostLive();
    } else if(phase === 'closed'){
      drawHostResult();
    } else {
      drawHostSuggest();
    }
    toast(`세션 ${HOST.code}을(를) 이어서 진행합니다`);
  }catch(err){
    const msg = String(err && err.message || err);
    // 세션이 서버에 없으면 무효한 캐시 — 정리 후 새 세션 화면
    if(/찾을 수 없|NOT_FOUND/.test(msg)){
      store.del('cv_host');
      HOST = { code:genCode(), title:'' };
      drawHostSetup();
      toast('이전 세션은 만료되었습니다. 새 세션을 만들어 주세요');
    } else {
      // 네트워크/일시 오류 — 사용자가 선택하도록 안내 화면
      HOST = saved;
      drawHostRecovery(msg);
    }
  }
}

/* 자동 복원 실패 시 사용자 선택 화면
   - "다시 시도" → renderHostSetup 재호출
   - "새 세션 만들기" → 기존 cv_host 정리 후 새 코드로 drawHostSetup
   - "이대로 이어서 진행" → 서버 확인 없이 그냥 drawHostSuggest (네트워크 복구 시 폴링으로 동기화) */
function drawHostRecovery(errMsg){
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="wrap narrow">
      <div class="card">
        <h2>⚠️ 진행 중인 세션 확인 실패</h2>
        <p class="sub">이전에 만든 세션 <b>${esc(HOST.code)}</b>의 상태를 서버에서 확인하지 못했습니다.<br>
          <span class="muted" style="font-size:.85rem;">사유: ${esc(errMsg)}</span></p>

        <div class="help" style="margin-top:.8rem;">
          ① 잠시 후 <b>다시 시도</b>해 보세요 (네트워크 일시 장애일 수 있습니다)<br>
          ② 세션이 살아있다고 확신하면 <b>이대로 이어서 진행</b>을 선택하세요<br>
          ③ 새로 시작하려면 <b>새 세션 만들기</b>를 선택하세요 (이전 데이터는 서버에 남아 있을 수 있으니, 동일 코드가 발급되면 데이터가 삭제될 수 있으므로 새 코드로 발급됩니다)
        </div>

        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1.2rem;">
          <button class="btn" id="retry" style="flex:1;min-width:120px;">🔄 다시 시도</button>
          <button class="btn ghost" id="continue" style="flex:1;min-width:120px;">이대로 이어서</button>
          <button class="btn ghost" id="fresh" style="flex:1;min-width:120px;">새 세션 만들기</button>
        </div>
      </div>
    </div>
  `));
  document.getElementById('retry').onclick     = ()=>renderHostSetup();
  document.getElementById('continue').onclick  = ()=>{
    HOST_MERGES   = HOST.merges   || [];
    HOST_EXCLUDED = HOST.excluded || {};
    HOST_RAW = []; HOST_SUGG = []; MERGE_PICK = {}; MERGE_MODE = false;
    drawHostSuggest();
  };
  document.getElementById('fresh').onclick = ()=>{
    store.del('cv_host');
    HOST = { code:genCode(), title:'' };
    HOST_MERGES = []; HOST_EXCLUDED = {}; HOST_RAW = []; HOST_SUGG = [];
    drawHostSetup();
  };
}

/* ---------- 진행자 STEP 0: 세션 생성 (제목만) ---------- */
function drawHostSetup(){
  app.innerHTML='';
  const c = el(`
    <div class="wrap narrow">
      <div class="steps">
        <div class="s active">① 후보 제안</div>
        <div class="s">② 투표 진행</div>
        <div class="s">③ 결과 집계</div>
      </div>
      <div class="card">
        <h2>새 활동 세션 만들기</h2>
        <p class="sub">후보는 미리 입력하지 않습니다. 세션을 열면 참여자들이 토론하며 실시간으로 후보를 제안합니다.</p>

        <label class="fld">활동 제목 <span class="muted">(선택)</span></label>
        <input type="text" id="title" maxlength="60" placeholder="예: 2026 우리 팀 핵심가치 선정" value="${esc(HOST.title)}">

        <div class="help">💡 진행 순서<br>
          ① 세션 생성 → 코드 공유<br>
          ② 참여자들이 각자 기기에서 후보 제안 (실시간 취합·중복 자동 병합)<br>
          ③ 진행자가 후보를 정리하고 <b>투표 시작</b><br>
          ④ 참여자들이 5점 척도로 투표 → 자동 집계</div>
      </div>
      <button class="btn lg full" id="create">세션 만들기 →</button>
    </div>
  `);
  app.appendChild(c);

  c.querySelector('#title').addEventListener('input', e=>{
    HOST.title = e.target.value; store.set('cv_host', HOST);
  });

  c.querySelector('#create').onclick = async (e)=>{
    HOST.title = c.querySelector('#title').value;
    const btn=e.target, prev=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> 생성 중…';
    try{
      if(isConfigured()) await gasPost('createSession', { code:HOST.code, title:HOST.title });
      store.set('cv_host', HOST);
      drawHostSuggest();
    }catch(err){
      btn.disabled=false; btn.innerHTML=prev;
      if(err.message==='NOT_CONFIGURED'){ store.set('cv_host',HOST); drawHostSuggest(); }
      else toast('세션 생성 실패: '+err.message);
    }
  };
}

/* ---------- 진행자 STEP 1: 후보 제안 실시간 모니터링 + 정리 ---------- */
let HOST_RAW = [];         // 백엔드/직접추가 원본 [{label,count,proposers}]
let HOST_SUGG = [];        // 병합 규칙 적용 후 표시용 [{label,count,proposers,members:[]}]
let HOST_EXCLUDED = {};    // 제외(체크 해제)한 (병합 후) 대표 라벨 집합
let HOST_MERGES = [];      // 병합 규칙 [{rep:'대표라벨', members:['라벨A','라벨B',...]}]
let MERGE_MODE = false;    // 병합 선택 모드 on/off
let MERGE_PICK = {};       // 병합 모드에서 선택한 (원본) 라벨 집합

/* 원본(HOST_RAW)에 병합 규칙(HOST_MERGES)을 적용해 표시용 HOST_SUGG 생성 */
function applyMerges(){
  // 라벨 → 소속 병합그룹 인덱스 매핑
  const memberOf = {};
  HOST_MERGES.forEach((m,gi)=> m.members.forEach(lb=> memberOf[lb.toLowerCase()] = gi));

  const groups = HOST_MERGES.map(m=>({ label:m.rep, count:0, proposers:[], members:[...m.members] }));
  const singles = [];

  HOST_RAW.forEach(s=>{
    const gi = memberOf[s.label.toLowerCase()];
    if(gi != null){
      const g = groups[gi];
      g.count += (s.count||0);
      (s.proposers||[]).forEach(p=>{ if(g.proposers.indexOf(p)<0) g.proposers.push(p); });
    }else{
      singles.push({ label:s.label, count:s.count||0, proposers:[...(s.proposers||[])], members:[s.label] });
    }
  });

  // 비어있지 않은 병합 그룹만 + 단독 후보 합치기
  const merged = groups.filter(g=>g.members.length>0).concat(singles);
  // 제안 많은 순 → 가나다순
  merged.sort((a,b)=> (b.count-a.count) || a.label.localeCompare(b.label,'ko'));
  HOST_SUGG = merged;
}

function drawHostSuggest(){
  app.innerHTML='';
  saveHostState();   // v2.2: 진입 즉시 상태 저장 (재진입 시 복원 가능하도록)
  const joinUrl = location.origin + location.pathname + '?s=' + HOST.code;
  const c = el(`
    <div class="wrap narrow">
      <div class="steps">
        <div class="s active">① 후보 제안</div>
        <div class="s">② 투표 진행</div>
        <div class="s">③ 결과 집계</div>
      </div>

      <div class="code-box">
        <div class="lbl">참여자 접속 코드</div>
        <div class="code">${esc(HOST.code)}</div>
        <div class="url">${esc(joinUrl)}</div>
        <div class="muted" style="font-size:.78rem;margin-top:.5rem;">💡 진행자 화면을 닫더라도, 같은 브라우저에서 다시 "진행자로 시작"을 누르면 이 세션으로 자동 복귀합니다</div>
      </div>
      <div class="row" style="margin-bottom:1.1rem;">
        <button class="btn ghost" id="copyurl">🔗 접속 링크 복사</button>
        <button class="btn ghost" id="copycode">📋 코드 복사</button>
      </div>

      <div class="card">
        <h2><span class="dot-live"></span>제안된 핵심가치 후보</h2>
        <p class="sub">참여자가 제안하면 실시간으로 모입니다. 비슷한 후보는 <b>병합</b>으로 합치고, 투표에서 뺄 후보는 체크를 해제하세요.</p>
        <div class="stat-grid">
          <div class="stat"><div class="v" id="cnt-cands">0</div><div class="l">제안 후보</div></div>
          <div class="stat"><div class="v" id="cnt-sugg">0</div><div class="l">총 제안 수</div></div>
          <div class="stat"><div class="v" id="cnt-keep">0</div><div class="l">투표 포함</div></div>
        </div>
        <div id="mergebar" class="mergebar hidden">
          <span id="mergehint">합칠 후보를 2개 이상 선택하세요</span>
          <div class="mergebar-btns">
            <button class="btn ghost" id="mergedo" disabled>선택 병합</button>
            <button class="btn outline" id="mergecancel">취소</button>
          </div>
        </div>
        <div id="sugglist"><p class="muted center" style="padding:1.4rem 0;">아직 제안된 후보가 없습니다.<br>참여자들이 제안하면 여기에 표시됩니다.</p></div>
        ${!isConfigured() ? `<div class="help">⚠️ 연동 미설정 상태입니다. 실제 제안은 <code>GAS_URL</code> 설정 후 표시됩니다. (아래는 미리보기 예시)</div>`:''}
      </div>

      <button class="btn lg full" id="startvote">투표 시작 (후보 확정) →</button>
      <div class="row" style="margin-top:.7rem;">
        <button class="btn outline" id="mergemode">🔗 후보 병합</button>
        <button class="btn outline" id="addmanual">+ 직접 추가</button>
      </div>
      <button class="btn outline full" id="reset" style="margin-top:.7rem;">새 세션 시작 (현재 세션 종료)</button>
    </div>
  `);
  app.appendChild(c);

  c.querySelector('#copyurl').onclick = ()=>copy(joinUrl,'접속 링크를 복사했습니다');
  c.querySelector('#copycode').onclick = ()=>copy(HOST.code,'코드를 복사했습니다');
  c.querySelector('#addmanual').onclick = async ()=>{
    const v = prompt('추가할 핵심가치 후보를 입력하세요');
    if(!v || !v.trim()) return;
    const label = v.trim();
    if(HOST_RAW.some(s=>s.label.toLowerCase()===label.toLowerCase())){
      toast('이미 있는 후보입니다');
      return;
    }
    try{
      if(isConfigured()){
        // v2: 진행자 추가도 시트에 저장 (voterId=진행자 식별자, name='진행자')
        await gasPost('suggest', {
          code: HOST.code,
          voterId: getHostId(),
          name: '진행자',
          team: '',
          candidate: label
        });
      }
      // 즉시 반영 (다음 폴링까지 기다리지 않도록)
      HOST_RAW.push({label, count:1, proposers:['진행자']});
      applyMerges();
      renderSuggList();
      toast('후보를 추가했습니다');
    }catch(err){
      toast(err.message==='NOT_CONFIGURED'
        ? '연동 설정 후 추가 가능합니다'
        : '추가 실패: ' + err.message);
    }
  };
  // 병합 모드 토글
  c.querySelector('#mergemode').onclick = ()=>{
    MERGE_MODE = true; MERGE_PICK = {};
    document.getElementById('mergebar').classList.remove('hidden');
    renderSuggList();
  };
  c.querySelector('#mergecancel').onclick = ()=>{
    MERGE_MODE = false; MERGE_PICK = {};
    document.getElementById('mergebar').classList.add('hidden');
    renderSuggList();
  };
  c.querySelector('#mergedo').onclick = doMerge;
  c.querySelector('#reset').onclick = ()=>{
    if(confirm('현재 세션을 종료하고 새 세션을 시작할까요?')){
      store.del('cv_host'); HOST=null; HOST_RAW=[]; HOST_SUGG=[]; HOST_EXCLUDED={};
      HOST_MERGES=[]; MERGE_MODE=false; MERGE_PICK={}; stopPolling();
      history.pushState({},'',location.pathname); renderLanding();
    }
  };
  c.querySelector('#startvote').onclick = startVote;

  // 미리보기용 더미
  if(!isConfigured() && HOST_RAW.length===0){
    HOST_RAW = [
      {label:'도전', count:4, proposers:['김','이','박','최']},
      {label:'신뢰', count:3, proposers:['김','정','한']},
      {label:'협업', count:3, proposers:['이','박','윤']},
      {label:'팀워크', count:2, proposers:['장','서']},
      {label:'고객중심', count:2, proposers:['최','한']},
      {label:'혁신', count:1, proposers:['정']},
    ];
  }

  applyMerges();
  renderSuggList();
  refreshHostSuggest();
  if(isConfigured()) pollTimer = setInterval(refreshHostSuggest, 3500);
}

/* 선택한 후보들을 하나로 병합 */
function doMerge(){
  const picked = HOST_SUGG.filter(s=>MERGE_PICK[s.label]);
  if(picked.length < 2){ toast('합칠 후보를 2개 이상 선택하세요'); return; }

  // 병합 그룹에 들어갈 모든 원본 라벨 수집
  const allMembers = [];
  picked.forEach(s=>(s.members||[s.label]).forEach(m=>{ if(allMembers.indexOf(m)<0) allMembers.push(m); }));

  // 대표 이름 선택: 가장 많이 제안된 후보를 기본값으로 제시
  const defaultRep = picked.slice().sort((a,b)=>b.count-a.count)[0].label;
  const rep = (prompt(`합칠 후보: ${picked.map(s=>s.label).join(', ')}\n\n대표로 쓸 이름을 입력하세요`, defaultRep) || '').trim();
  if(!rep){ return; }

  // 기존 병합 규칙 중 이번에 포함된 멤버가 있던 그룹은 제거(재구성)
  HOST_MERGES = HOST_MERGES.filter(g=> !g.members.some(m=>allMembers.indexOf(m)>=0));
  HOST_MERGES.push({ rep, members: allMembers });

  // 상태 초기화 및 재렌더
  MERGE_MODE=false; MERGE_PICK={};
  delete HOST_EXCLUDED[/* 이전 라벨 흔적 정리 불필요 */ ''];
  const bar=document.getElementById('mergebar'); if(bar) bar.classList.add('hidden');
  applyMerges(); renderSuggList();
  saveHostState();   // v2.2: 병합 규칙 보존
  toast(`'${rep}'(으)로 ${picked.length}개 후보를 병합했습니다`);
}

async function refreshHostSuggest(){
  if(!isConfigured()) return;
  try{
    const data = await gasGet({ action:'getSuggestions', code:HOST.code });
    // v2: 진행자 추가도 시트에 저장되므로 manual 분리 불필요
    HOST_RAW = data.suggestions || [];
    applyMerges();
    renderSuggList();
  }catch(err){ /* 폴링 실패는 무시 */ }
}

function renderSuggList(){
  injectHostSuggStyles();
  const box = document.getElementById('sugglist');
  if(!box) return;
  const totalSugg = HOST_SUGG.reduce((a,s)=>a+(s.count||0),0);
  const kept = HOST_SUGG.filter(s=>!HOST_EXCLUDED[s.label]);
  setText('cnt-cands', HOST_SUGG.length);
  setText('cnt-sugg', totalSugg);
  setText('cnt-keep', kept.length);

  if(!HOST_SUGG.length){
    box.innerHTML = `<p class="muted center" style="padding:1.4rem 0;">아직 제안된 후보가 없습니다.<br>참여자들이 제안하면 여기에 표시됩니다.</p>`;
    updateMergeBar();
    return;
  }

  box.innerHTML = HOST_SUGG.map(s=>{
    const excluded = !!HOST_EXCLUDED[s.label];
    const picked = !!MERGE_PICK[s.label];
    const proposers = (s.proposers||[]).slice(0,6).join(', ') + ((s.proposers||[]).length>6?' 외':'');
    const isMerged = (s.members||[]).length>1;
    // v2: 진행자가 단독으로 추가한 후보(다른 사람이 같은 라벨로 제안 안 함)에만 삭제 버튼 표시
    //     - 병합되지 않은 단독 항목 & proposers가 '진행자' 하나뿐일 때만
    const isHostOnly = !isMerged
      && (s.proposers||[]).length === 1
      && s.proposers[0] === '진행자'
      && !MERGE_MODE;
    // 병합 모드: 선택용 행 / 일반 모드: 포함 체크 행
    const control = MERGE_MODE
      ? `<label class="sugg-check pick">
           <input type="checkbox" class="pickbox" ${picked?'checked':''} data-label="${esc(s.label)}">
           <span class="box"></span></label>`
      : `<label class="sugg-check">
           <input type="checkbox" class="keepbox" ${excluded?'':'checked'} data-label="${esc(s.label)}">
           <span class="box"></span></label>`;
    return `<div class="sugg-row ${excluded&&!MERGE_MODE?'excluded':''} ${picked?'picked':''}" data-label="${esc(s.label)}">
      ${control}
      <div class="sugg-info">
        <div class="sugg-name">${esc(s.label)}${isMerged?` <span class="merge-tag">병합 ${s.members.length}</span>`:''}${isHostOnly?` <span class="host-tag">진행자 추가</span>`:''}</div>
        ${proposers?`<div class="sugg-meta">제안: ${esc(proposers)}</div>`:''}
        ${isMerged?`<div class="sugg-meta">합쳐진 후보: ${esc(s.members.join(', '))} · <span class="unmerge" data-label="${esc(s.label)}">병합 해제</span></div>`:''}
      </div>
      ${s.count?`<div class="sugg-cnt">×${s.count}</div>`:`<div class="sugg-cnt manual">직접</div>`}
      ${isHostOnly?`<button type="button" class="host-del" data-label="${esc(s.label)}" aria-label="${esc(s.label)} 삭제" title="진행자 추가 후보 삭제">🗑️</button>`:''}
    </div>`;
  }).join('');

  // 포함 체크박스 (일반 모드)
  box.querySelectorAll('.keepbox').forEach(cb=>{
    cb.onchange = ()=>{
      const label = cb.dataset.label;
      if(cb.checked) delete HOST_EXCLUDED[label]; else HOST_EXCLUDED[label]=true;
      cb.closest('.sugg-row').classList.toggle('excluded', !cb.checked);
      setText('cnt-keep', HOST_SUGG.filter(s=>!HOST_EXCLUDED[s.label]).length);
      saveHostState();   // v2.2: 제외 상태 보존 (재진입 시 복원용)
    };
  });
  // 선택 체크박스 (병합 모드)
  box.querySelectorAll('.pickbox').forEach(cb=>{
    cb.onchange = ()=>{
      const label = cb.dataset.label;
      if(cb.checked) MERGE_PICK[label]=true; else delete MERGE_PICK[label];
      cb.closest('.sugg-row').classList.toggle('picked', cb.checked);
      updateMergeBar();
    };
  });
  // 병합 해제
  box.querySelectorAll('.unmerge').forEach(u=>{
    u.onclick = ()=>{
      const rep = u.dataset.label;
      HOST_MERGES = HOST_MERGES.filter(g=>g.rep!==rep);
      delete HOST_EXCLUDED[rep];
      applyMerges(); renderSuggList();
      saveHostState();   // v2.2: 병합 규칙 변경 보존
      toast('병합을 해제했습니다');
    };
  });
  // v2: 진행자 추가 후보 삭제
  box.querySelectorAll('.host-del').forEach(btn=>{
    btn.onclick = async ()=>{
      const label = btn.dataset.label;
      if(!confirm(`진행자가 추가한 '${label}' 후보를 삭제할까요?\n(다시 추가할 수 있습니다)`)) return;

      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = '…';
      try{
        if(isConfigured()){
          await gasPost('removeSuggestion', {
            code: HOST.code,
            voterId: getHostId(),
            name: '진행자',
            team: '',
            candidate: label
          });
        }
        // 즉시 반영
        HOST_RAW = HOST_RAW.filter(s => s.label.toLowerCase() !== label.toLowerCase());
        delete HOST_EXCLUDED[label];
        applyMerges();
        renderSuggList();
        toast('후보를 삭제했습니다');
      }catch(err){
        btn.disabled = false; btn.textContent = prev;
        if(err.message === 'NOT_CONFIGURED'){
          toast('연동 설정 후 삭제 가능합니다');
        } else if(err.message === 'NOT_FOUND'){
          // 서버와 어긋남: 로컬에서만 정리
          HOST_RAW = HOST_RAW.filter(s => s.label.toLowerCase() !== label.toLowerCase());
          applyMerges();
          renderSuggList();
          toast('이미 처리된 후보입니다');
        } else {
          toast('삭제 실패: ' + err.message);
        }
      }
    };
  });

  updateMergeBar();
}

/* 진행자 화면 전용 추가 스타일 (진행자 추가 후보 태그/휴지통 버튼)
   - index.html 수정 없이 동적으로 1회 주입 */
function injectHostSuggStyles(){
  if(document.getElementById('cv-host-sugg-styles')) return;
  const s = document.createElement('style');
  s.id = 'cv-host-sugg-styles';
  s.textContent = `
    .host-tag{
      display:inline-block; background:#fff2e6; color:#b25a17;
      font-size:.66rem; font-weight:800; padding:.08rem .4rem;
      border-radius:5px; vertical-align:middle; margin-left:.2rem;
    }
    .sugg-row .host-del{
      background:none; border:1px solid var(--line); border-radius:8px;
      width:2rem; height:2rem; cursor:pointer; font-size:.9rem; line-height:1;
      display:inline-flex; align-items:center; justify-content:center;
      flex-shrink:0; margin-left:.4rem; padding:0;
      transition:background .15s, border-color .15s;
      touch-action:manipulation;
    }
    .sugg-row .host-del:hover,
    .sugg-row .host-del:focus{
      background:#fdecea; border-color:#c0392b; outline:none;
    }
    .sugg-row .host-del:disabled{ opacity:.45; cursor:not-allowed; }
  `;
  document.head.appendChild(s);
}

function updateMergeBar(){
  const bar = document.getElementById('mergebar');
  if(!bar) return;
  bar.classList.toggle('hidden', !MERGE_MODE);
  const n = Object.keys(MERGE_PICK).length;
  const hint = document.getElementById('mergehint');
  const doBtn = document.getElementById('mergedo');
  if(hint) hint.textContent = n>=2 ? `${n}개 후보를 합칩니다` : '합칠 후보를 2개 이상 선택하세요';
  if(doBtn) doBtn.disabled = n<2;
}

async function startVote(e){
  const kept = HOST_SUGG.filter(s=>!HOST_EXCLUDED[s.label]).map(s=>s.label);
  if(kept.length < 2){ toast('투표에 포함할 후보를 2개 이상 남겨주세요'); return; }
  if(!confirm(`${kept.length}개 후보로 투표를 시작할까요?\n시작 후에는 후보 제안이 마감됩니다.`)) return;

  const btn=e.target, prev=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span> 후보 확정 중…';
  try{
    if(isConfigured()) await gasPost('finalize', { code:HOST.code, candidates:kept });
    HOST.candidates = kept; store.set('cv_host', HOST);
    drawHostLive();
  }catch(err){
    btn.disabled=false; btn.innerHTML=prev;
    if(err.message==='NOT_CONFIGURED'){ HOST.candidates=kept; store.set('cv_host',HOST); drawHostLive(); }
    else toast('후보 확정 실패: '+err.message);
  }
}

/* ---------- 진행자 STEP 2: 투표 진행 모니터링 ---------- */
function drawHostLive(){
  app.innerHTML='';
  const c = el(`
    <div class="wrap narrow">
      <div class="steps">
        <div class="s done">① 후보 제안</div>
        <div class="s active">② 투표 진행</div>
        <div class="s">③ 결과 집계</div>
      </div>

      <div class="card">
        <h2><span class="dot-live"></span>투표 진행 중</h2>
        <p class="sub">코드 <b>${esc(HOST.code)}</b> · 확정 후보 ${HOST.candidates.length}개로 투표가 진행됩니다.</p>
        <div class="stat-grid">
          <div class="stat"><div class="v" id="cnt-voters">0</div><div class="l">투표 완료</div></div>
          <div class="stat"><div class="v">${HOST.candidates.length}</div><div class="l">후보 수</div></div>
          <div class="stat"><div class="v" id="cnt-votes">0</div><div class="l">총 평가 수</div></div>
        </div>
        <div id="voterlist" class="voter-chips"></div>
        ${!isConfigured() ? `<div class="help">⚠️ 연동 미설정 상태입니다. 실제 현황은 <code>GAS_URL</code> 설정 후 표시됩니다.</div>`:''}
      </div>

      <button class="btn lg full" id="toresult">투표 마감 · 결과 집계 →</button>
      <button class="btn outline full" id="reset" style="margin-top:.7rem;">새 세션 시작 (현재 세션 종료)</button>
    </div>
  `);
  app.appendChild(c);
  c.querySelector('#toresult').onclick = ()=>drawHostResult();
  c.querySelector('#reset').onclick = ()=>{
    if(confirm('현재 세션을 종료하고 새 세션을 시작할까요?')){
      store.del('cv_host'); HOST=null; HOST_RAW=[]; HOST_SUGG=[]; HOST_EXCLUDED={};
      HOST_MERGES=[]; MERGE_MODE=false; MERGE_PICK={}; stopPolling();
      history.pushState({},'',location.pathname); renderLanding();
    }
  };

  refreshHostLive();
  if(isConfigured()) pollTimer = setInterval(refreshHostLive, 4000);
}

async function refreshHostLive(){
  if(!isConfigured()) return;
  try{
    const data = await gasGet({ action:'getResults', code:HOST.code });
    const voters = data.voters || [];
    const totalVotes = (data.results||[]).reduce((a,r)=>a+(r.count||0),0);
    setText('cnt-voters', voters.length);
    setText('cnt-votes', totalVotes);
    const list = document.getElementById('voterlist');
    if(list){
      list.innerHTML = voters.length
        ? voters.map(v=>`<span class="chip">${esc(v)}</span>`).join('')
        : '<span class="muted">아직 투표한 참여자가 없습니다.</span>';
    }
  }catch(err){ /* 무시 */ }
}

/* ---------- 진행자 STEP 3: 결과 집계 ---------- */
async function drawHostResult(){
  stopPolling();
  app.innerHTML='';
  const c = el(`
    <div class="wrap narrow">
      <div class="steps">
        <div class="s done">① 후보 제안</div>
        <div class="s done">② 투표 진행</div>
        <div class="s active">③ 결과 집계</div>
      </div>
      <div id="resultarea" class="card">
        <h2>총점 집계 &amp; 상위 3개 확정</h2>
        <p class="sub">개인 점수를 합산해 상위 3개 핵심가치를 자동 산출합니다.</p>
        <div class="center" style="padding:2rem 0;"><span class="spinner" style="border-color:#cfd6db;border-top-color:var(--green-600);width:1.8rem;height:1.8rem;"></span></div>
      </div>
      <div class="row">
        <button class="btn outline" id="back">← 투표 현황으로</button>
        <button class="btn ghost" id="refresh">↻ 다시 집계</button>
      </div>
      <button class="btn lg full" id="save" style="margin-top:.7rem;">📷 결과 이미지 저장</button>
    </div>
  `);
  app.appendChild(c);
  c.querySelector('#back').onclick = ()=>drawHostLive();
  c.querySelector('#refresh').onclick = ()=>drawHostResult();
  c.querySelector('#save').onclick = ()=>saveResultImage('resultarea');
  await loadResults('resultarea', HOST.code, HOST.candidates);
}

/* 결과 렌더링 (공용) */
async function loadResults(containerId, code, candidatesHint){
  const box = document.getElementById(containerId);
  let results, voters;
  try{
    if(isConfigured()){
      const data = await gasGet({ action:'getResults', code });
      results = data.results; voters = data.voters || [];
    }else{
      results = (candidatesHint||['후보 A','후보 B','후보 C']).map(nm=>({name:nm,sum:0,count:0,avg:0}));
      voters=[];
    }
  }catch(err){
    box.innerHTML = `<h2>총점 집계 &amp; 상위 3개 확정</h2>
      <div class="err-banner">결과를 불러오지 못했습니다: ${esc(err.message)}</div>`;
    return;
  }
  results.sort((a,b)=> (b.sum-a.sum) || (b.avg-a.avg));
  const maxSum = Math.max(1, ...results.map(r=>r.sum));
  const tie = detectTie(results);

  box.innerHTML = `
    <h2>총점 집계 &amp; 상위 3개 확정</h2>
    <p class="sub">${voters.length}명 참여 · 합계 점수 기준 내림차순</p>
    ${results.map((r,i)=>{
      const top = i<3;
      return `<div class="res-row ${top?'top3':''}">
        <div class="rank">${i+1}</div>
        <div class="info"><div class="nm">${esc(r.name)}</div>
          <div class="meta">${top?'⭐ 상위 3개':''}</div></div>
        <div class="bar-wrap"><div class="bar"><i style="width:${(r.sum/maxSum*100).toFixed(1)}%"></i></div></div>
        <div><div class="score">${r.sum}점</div><div class="avg">평균 ${r.avg.toFixed(2)}</div></div>
      </div>`;
    }).join('')}
    ${tie ? `<div class="tie-warn">⚖️ <b>동점 발생</b> — 3위 경계에서 ${esc(tie)}점으로 동점인 후보가 있습니다. 슬라이드 기준에 따라 <b>팀 리더 합의로 결정</b>하세요.</div>`:''}
  `;
}

function detectTie(sorted){
  if(sorted.length<=3) return null;
  if(sorted[2] && sorted[3] && sorted[2].sum===sorted[3].sum && sorted[2].sum>0) return sorted[2].sum;
  return null;
}

/* =========================================================
   참여자 (VOTER)
   ========================================================= */
let VOTE = null;  // { code, name, team, phase, candidates:[], answers:{} }

function renderVoter(prefillCode){
  stopPolling();
  drawVoterJoin(prefillCode);
}

function drawVoterJoin(prefillCode){
  app.innerHTML='';
  const c = el(`
    <div class="wrap narrow">
      <div class="card">
        <h2>활동 참여</h2>
        <p class="sub">진행자가 안내한 4자리 코드와 본인 정보를 입력하세요.</p>
        ${!isConfigured() ? `<div class="err-banner">⚠️ 연동 미설정 상태입니다. 실제 참여는 <code>GAS_URL</code> 설정 후 가능합니다.</div>`:''}
        <label class="fld">세션 코드</label>
        <input type="text" id="code" inputmode="numeric" maxlength="4" placeholder="예: 1234"
          value="${esc(prefillCode||'')}" style="margin-bottom:1rem;letter-spacing:.3rem;font-weight:700;font-size:1.3rem;text-align:center;">
        <label class="fld">이름</label>
        <input type="text" id="name" maxlength="20" placeholder="이름 또는 닉네임" style="margin-bottom:1rem;">
        <label class="fld">팀 <span class="muted">(선택)</span></label>
        <input type="text" id="team" maxlength="20" placeholder="예: 1팀" style="margin-bottom:1.3rem;">
        <button class="btn lg full" id="enter">참여하기 →</button>
      </div>
    </div>
  `);
  app.appendChild(c);
  if(!prefillCode) c.querySelector('#code').focus(); else c.querySelector('#name').focus();

  c.querySelector('#enter').onclick = async (e)=>{
    const code = c.querySelector('#code').value.trim();
    const name = c.querySelector('#name').value.trim();
    const team = c.querySelector('#team').value.trim();
    if(!/^\d{4}$/.test(code)){ toast('4자리 코드를 입력하세요'); return; }
    if(!name){ toast('이름을 입력하세요'); return; }

    const btn=e.target, prev=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> 확인 중…';
    try{
      let phase='suggest', candidates=[];
      if(isConfigured()){
        const data = await gasGet({ action:'getSession', code });
        phase = data.phase || 'suggest';
        candidates = data.candidates || [];
      }
      VOTE = { code, name, team, phase, candidates, answers:{} };
      if(phase==='vote') drawVoterBallot();
      else drawVoterSuggest();
    }catch(err){
      btn.disabled=false; btn.innerHTML=prev;
      toast(err.message==='NOT_CONFIGURED' ? '연동 설정 후 이용 가능합니다' : err.message);
    }
  };
}

/* ---------- 참여자: 후보 제안 ---------- */

/* 참여자 화면 전용 추가 스타일 (chip 안의 삭제 버튼)
   - index.html을 건드리지 않기 위해 동적으로 <style>을 1회만 주입 */
function injectVoterChipStyles(){
  if(document.getElementById('cv-voter-chip-styles')) return;
  const s = document.createElement('style');
  s.id = 'cv-voter-chip-styles';
  s.textContent = `
    .voter-chips .chip.removable{
      display:inline-flex; align-items:center; gap:.4rem;
      padding:.3rem .35rem .3rem .7rem;
    }
    .voter-chips .chip-del{
      background:rgba(0,0,0,.06); border:none; color:var(--green-700);
      width:1.35rem; height:1.35rem; border-radius:50%; cursor:pointer;
      font-size:1.05rem; font-weight:800; line-height:1;
      display:inline-flex; align-items:center; justify-content:center;
      padding:0; transition:background .15s, color .15s;
      touch-action:manipulation;
    }
    .voter-chips .chip-del:hover,
    .voter-chips .chip-del:focus{
      background:rgba(192,57,43,.15); color:#c0392b; outline:none;
    }
    .voter-chips .chip-del:disabled{ opacity:.45; cursor:not-allowed; }
    .mine-hint{ font-size:.78rem; color:var(--ink-soft); margin-top:.4rem; }
  `;
  document.head.appendChild(s);
}

function drawVoterSuggest(){
  app.innerHTML='';
  injectVoterChipStyles();

  const c = el(`
    <div class="wrap narrow">
      <div class="card">
        <h2>핵심가치 후보 제안</h2>
        <p class="sub"><b>${esc(VOTE.name)}</b>${VOTE.team?` · ${esc(VOTE.team)}`:''} 님 · 비전과 정합성이 높다고 생각하는 핵심가치를 제안하세요. 여러 개 제안할 수 있습니다.</p>

        <div class="row" style="gap:.5rem;">
          <input type="text" id="cand" maxlength="30" placeholder="예: 도전, 신뢰, 협업…" style="flex:2;" autocomplete="off" autocapitalize="off" enterkeyhint="done">
          <button class="btn" id="add" style="flex:1;">제안</button>
        </div>

        <div id="mine" style="margin-top:1.1rem;"></div>
        <div class="help" id="waithint">진행자가 후보를 정리한 뒤 <b>투표</b>를 시작하면 이 화면이 자동으로 투표로 전환됩니다. 잠시 기다려 주세요.</div>
      </div>
    </div>
  `);
  app.appendChild(c);

  // 새로고침 대응: sessionStorage에서 본인 제안 목록 복원
  VOTE.mySuggestions = VOTE.mySuggestions && VOTE.mySuggestions.length
    ? VOTE.mySuggestions
    : loadMySuggestions(VOTE.code);

  const input = c.querySelector('#cand');
  input.focus();

  function renderMine(){
    const box = c.querySelector('#mine');
    if(!VOTE.mySuggestions.length){
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="muted" style="font-size:.84rem;margin-bottom:.4rem;font-weight:700;">내가 제안한 후보 <span class="muted" style="font-weight:500;">(× 버튼으로 취소 가능)</span></div>
      <div class="voter-chips">
        ${VOTE.mySuggestions.map(s=>`
          <span class="chip removable">
            ${esc(s)}
            <button type="button" class="chip-del" data-cand="${esc(s)}" aria-label="${esc(s)} 제안 삭제">×</button>
          </span>`).join('')}
      </div>
      <div class="mine-hint">삭제 후 다시 같은 키워드를 제안할 수 있습니다.</div>
    `;
    bindMineDelete();
  }

  /* 본인 제안 삭제 버튼 핸들러 */
  function bindMineDelete(){
    c.querySelectorAll('.chip-del').forEach(btn=>{
      btn.onclick = async (e)=>{
        e.stopPropagation();
        const cand = btn.dataset.cand;
        if(!cand) return;
        if(!confirm(`'${cand}' 제안을 취소할까요?\n(취소 후 다시 제안할 수 있습니다)`)) return;

        const prev = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try{
          if(isConfigured()){
            await gasPost('removeSuggestion', {
              code: VOTE.code,
              voterId: getVoterId(),
              name: VOTE.name,
              team: VOTE.team,
              candidate: cand
            });
          }
          // 클라이언트 상태 갱신
          VOTE.mySuggestions = VOTE.mySuggestions.filter(s => s.toLowerCase() !== cand.toLowerCase());
          saveMySuggestions(VOTE.code, VOTE.mySuggestions);
          renderMine();
          toast('제안을 취소했습니다');
        }catch(err){
          btn.disabled = false; btn.textContent = prev;
          if(err.message === 'NOT_CONFIGURED'){
            toast('연동 설정 후 삭제 가능합니다');
          } else if(err.message === 'NOT_FOUND'){
            // 서버 상태와 어긋난 경우: 로컬에서만 정리
            VOTE.mySuggestions = VOTE.mySuggestions.filter(s => s.toLowerCase() !== cand.toLowerCase());
            saveMySuggestions(VOTE.code, VOTE.mySuggestions);
            renderMine();
            toast('이미 처리된 제안입니다');
          } else {
            toast('삭제 실패: ' + err.message);
          }
        }
      };
    });
  }
  renderMine();

  async function submitCand(){
    const v = input.value.trim();
    if(!v){ toast('후보를 입력하세요'); return; }
    if(VOTE.mySuggestions.some(s=>s.toLowerCase()===v.toLowerCase())){ toast('이미 제안했습니다'); return; }
    const btn=c.querySelector('#add'), prev=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='…';
    try{
      if(isConfigured()){
        await gasPost('suggest', {
          code: VOTE.code,
          voterId: getVoterId(),
          name: VOTE.name,
          team: VOTE.team,
          candidate: v
        });
      }
      VOTE.mySuggestions.push(v);
      saveMySuggestions(VOTE.code, VOTE.mySuggestions);
      input.value=''; renderMine(); toast('제안 완료'); input.focus();
    }catch(err){
      toast(err.message==='NOT_CONFIGURED'?'연동 설정 후 제안 가능합니다':err.message);
    }finally{ btn.disabled=false; btn.innerHTML=prev; }
  }
  c.querySelector('#add').onclick = submitCand;
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') submitCand(); });

  // phase 폴링: 진행자가 투표 시작하면 자동 전환
  if(isConfigured()){
    pollTimer = setInterval(async ()=>{
      try{
        const data = await gasGet({ action:'getSession', code:VOTE.code });
        if(data.phase==='vote'){
          stopPolling();
          VOTE.candidates = data.candidates || [];
          VOTE.phase='vote';
          drawVoterBallot();
        }
      }catch(err){ /* 무시 */ }
    }, 4000);
  }
}

/* ---------- 참여자: 투표 ---------- */
function drawVoterBallot(){
  app.innerHTML='';
  const legend = SCALE.map(s=>`
    <div class="lg ${s.n===5?'top':s.n===4?'hi':''}">
      <div class="circle">${s.n}</div><div class="h">${s.t}</div><div class="d">${s.d}</div>
    </div>`).join('');
  const cands = VOTE.candidates.map((nm,ci)=>`
    <div class="vote-cand" data-ci="${ci}">
      <div class="name"><span class="num">${ci+1}</span>${esc(nm)}</div>
      <div class="scale">
        ${SCALE.map(s=>`<div class="opt" data-ci="${ci}" data-v="${s.n}">
          <div class="n">${s.n}</div><div class="t">${s.t}</div><div class="od">${s.d}</div></div>`).join('')}
      </div>
    </div>`).join('');

  const c = el(`
    <div class="wrap narrow">
      <div class="card">
        <h2>개인별 5점 척도 투표</h2>
        <p class="sub"><b>${esc(VOTE.name)}</b>${VOTE.team?` · ${esc(VOTE.team)}`:''} 님 · 비전과의 정합성을 기준으로 각 후보에 점수를 매기세요.</p>
        <div class="legend">${legend}</div>
      </div>
      ${cands}
      <div class="card submit-bar">
        <div class="muted center" id="progress" style="margin-bottom:.7rem;">0 / ${VOTE.candidates.length} 응답 완료</div>
        <button class="btn lg full" id="submit" disabled>제출하기</button>
      </div>
    </div>
  `);
  app.appendChild(c);

  c.querySelectorAll('.scale .opt').forEach(opt=>{
    opt.onclick = ()=>{
      const ci=+opt.dataset.ci, v=+opt.dataset.v;
      VOTE.answers[ci]=v;
      const card=opt.closest('.vote-cand');
      card.querySelectorAll('.opt').forEach(o=>o.classList.remove('sel'));
      opt.classList.add('sel'); card.classList.add('answered');
      const done=Object.keys(VOTE.answers).length, total=VOTE.candidates.length;
      c.querySelector('#progress').textContent=`${done} / ${total} 응답 완료`;
      c.querySelector('#submit').disabled = done<total;
    };
  });

  c.querySelector('#submit').onclick = async (e)=>{
    if(Object.keys(VOTE.answers).length<VOTE.candidates.length){ toast('모든 후보에 점수를 매겨주세요'); return; }
    const btn=e.target, prev=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span> 제출 중…';
    const scores = VOTE.candidates.map((nm,ci)=>({ name:nm, score:VOTE.answers[ci] }));
    try{
      if(isConfigured()) await gasPost('submitVote', { code:VOTE.code, name:VOTE.name, team:VOTE.team, scores });
      drawVoterDone();
    }catch(err){
      btn.disabled=false; btn.innerHTML=prev;
      toast(err.message==='NOT_CONFIGURED'?'연동 설정 후 제출 가능합니다':'제출 실패: '+err.message);
    }
  };
}

function drawVoterDone(){
  app.innerHTML='';
  const c = el(`
    <div class="wrap narrow">
      <div class="card center" style="padding:2.6rem 1.6rem;">
        <div style="width:4rem;height:4rem;border-radius:50%;background:var(--green-100);
          display:flex;align-items:center;justify-content:center;margin:0 auto 1.1rem;">
          <svg viewBox="0 0 24 24" fill="none" style="width:2rem;height:2rem;">
            <path d="M5 13l4 4L19 7" stroke="#22a248" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2 style="margin-bottom:.4rem;">투표가 제출되었습니다</h2>
        <p class="muted"><b>${esc(VOTE.name)}</b> 님의 응답이 정상 접수되었습니다.<br>진행자 화면에서 집계 결과를 확인하세요.</p>
      </div>
    </div>
  `);
  app.appendChild(c);
}

/* ====================== 공통 헬퍼 ====================== */
function setText(id,v){ const e=document.getElementById(id); if(e) e.textContent=v; }
async function copy(text,msg){
  try{ await navigator.clipboard.writeText(text); toast(msg); }
  catch{ const t=document.createElement('textarea'); t.value=text; document.body.appendChild(t);
    t.select(); try{document.execCommand('copy'); toast(msg);}catch{toast('복사 실패');} t.remove(); }
}
function saveResultImage(containerId){
  const node=document.getElementById(containerId);
  if(!node || typeof html2canvas==='undefined'){ toast('이미지 저장을 사용할 수 없습니다'); return; }
  toast('이미지 생성 중…');
  html2canvas(node,{backgroundColor:'#ffffff',scale:2}).then(canvas=>{
    const a=document.createElement('a');
    a.download=`핵심가치_집계결과_${new Date().toISOString().slice(0,10)}.png`;
    a.href=canvas.toDataURL('image/png'); a.click();
  }).catch(()=>toast('이미지 저장 실패'));
}

/* ====================== 시작 ====================== */
route();
