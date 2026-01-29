const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";

export async function chatCompletion({ prompt, temperature = 0.2 }) {
  const r = await fetch(`${LLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      temperature,
      messages: [
        { role: "system", content: "You are a precise browser automation agent. Output ONLY JSON." },
        { role: "user", content: prompt }
      ]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`llama-server ${r.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);

  return json?.choices?.[0]?.message?.content ?? "";
}
