/* =====================================================================
   Gemini 중계 함수 (Vercel Serverless Function)
   - 키는 Vercel 환경변수 GEMINI_API_KEY 에만 존재한다.
     브라우저·GitHub 어디에도 키가 노출되지 않는다.
   - GET                          → { ok, hasKey } : 프론트가 자연어 입력 표시 여부 판단
   - POST { action:"listModels" } → 사용 가능 모델 목록 (Gemini 응답·상태코드 그대로 전달)
   - POST { action:"generate", model, text }
                                  → NL_PROMPT(서버 고정)를 붙여 generateContent 호출
   도용 방지: 허용 action 2개뿐, 프롬프트는 서버에 고정, model 형식·text 길이 검증.
   상태코드를 그대로 전달하므로 프론트의 404(모델 전환)/429(재시도)/5xx(폴백)
   처리 로직이 수정 없이 동작한다.
   ===================================================================== */

const NL_PROMPT = [
  "너는 감정 상태 설명을 러셀 감정 원형 모델 좌표로 변환하는 변환기다.",
  "사용자의 한국어 설명에서 '지금 상태'와 '원하는 목표 상태'를 각각 추출해",
  "v(감정가: 0=매우 부정, 0.5=중립, 1=매우 긍정)와",
  "e(각성도/활력: 0=매우 낮음(처짐·나른함), 0.5=보통, 1=매우 높음(긴장·흥분))로 표현하라.",
  "각성도는 긍정/부정과 무관한 활성화 수준이다: 시험 긴장은 v낮음+e높음,",
  "무기력·번아웃은 v낮음+e낮음, 신남은 v높음+e높음, 편안함은 v높음+e낮음이다.",
  "설명에 목표가 없으면 target은 null로 두어라. 지금 상태가 없으면 current를 null로 두어라.",
  "reason에는 해석 근거를 한국어 한 문장으로 써라.",
  "JSON만 출력: {\"current\":{\"v\":0~1,\"e\":0~1}|null,\"target\":{\"v\":0~1,\"e\":0~1}|null,\"reason\":\"...\"}"
].join("\n");

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export default async function handler(req, res) {
  const KEY = process.env.GEMINI_API_KEY || "";

  // 프론트 초기화용 상태 확인 — 키 값 자체는 절대 내려보내지 않는다
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hasKey: !!KEY });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (!KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  const { action, model, text } = req.body || {};

  try {
    if (action === "listModels") {
      const r = await fetch(BASE + "/models?pageSize=200&key=" + encodeURIComponent(KEY));
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    if (action === "generate") {
      if (typeof model !== "string" || !/^gemini-[\w.-]{1,80}$/.test(model)) {
        return res.status(400).json({ error: "invalid model" });
      }
      if (typeof text !== "string" || !text.trim() || text.length > 600) {
        return res.status(400).json({ error: "invalid text" });
      }
      const r = await fetch(
        BASE + "/models/" + model + ":generateContent?key=" + encodeURIComponent(KEY),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: NL_PROMPT + "\n\n사용자 설명: " + text.trim() }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
          })
        }
      );
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(502).json({ error: "upstream failure", detail: String((e && e.message) || e) });
  }
}
