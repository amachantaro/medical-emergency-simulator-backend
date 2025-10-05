require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 5001;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

app.use(cors());
app.use(express.json());

const rules = `
# あなたの役割：急変対応シミュレーションのゲームマスター

## 基本的な振る舞い
1.  あなたは、プレイヤー（看護師）の訓練相手です。
2.  状況を具体的に描写し、常に「次にどうしますか？」とプレイヤーに行動を促してください。
3.  プレイヤーの行動の結果、何が起きたかを客観的に描写してください。
4.  プレイヤーの学習機会を奪わないでください。プレイヤーの代わりに重要な判断（応援要請など）をしないでください。

## シナリオのルール
*   **舞台:** 深夜の病棟
*   **登場人物:** 
    *   プレイヤー（看護師）
    *   先輩看護師A（仮眠室で休憩中。PHSなし。直接呼びに行く必要あり）
    *   先輩看護師B（巡視中。PHSあり）
    *   医師（スタットコールでのみ数分後に到着）
*   **最重要ルール:** 
    *   **薬剤投与:** アドレナリンなどの薬剤投与は、医師の指示がなければ絶対にできません。
    *   **ドクターヘリ:** 登場しません。
`;

// シミュレーション開始エンドポイント
app.get('/start-simulation', (req, res) => {
  try {
    const scenario = req.query.scenario;

    let startText;
    if (scenario === 'responder') {
      startText = `深夜0時過ぎ、あなたは病棟で記録作業をしていると、PHSから「ピロピロ」という緊急コールが鳴り響きました。
**先輩看護師B**からの、個室での急変を知らせる連絡です。

あなたが病室に駆けつけると、**先輩看護師B**が患者に胸骨圧迫を行っています。
患者の顔色は蒼白で、呼吸は確認できません。
先輩Bの額には汗が滲み、「来てくれたのね！助かる！AEDをお願いできる！？」と叫んでいます。先輩看護師Aは仮眠室で休憩中です。

まず、どうしますか？`;
    } else { // 'discoverer' or any other case
      startText = `深夜0時過ぎ、あなたは病棟を巡視中、病室で患者が倒れているのを発見しました。
呼びかけにも肩を叩いても反応がなく、呼吸も確認できません。
二人いる先輩看護師のうち、先輩看護師Aは休憩中、先輩看護師Bは巡視中でどこにいるかわかりません。

まず、どうしますか？`;
    }
    
    res.json({ text: startText });

  } catch (error) {
    console.error('Error starting simulation:', error);
    res.status(500).json({ error: 'シミュレーションの開始に失敗しました。' });
  }
});

// チャットエンドポイント
app.post('/chat', async (req, res) => {
  try {
    const history = req.body.history || [];
    const message = req.body.message;

    // 1. Construct the full conversation list in a generic format
    const fullConversation = [
      { role: 'system', parts: [{ text: rules }] },
      ...history.map(h => ({ role: h.role === 'ai' ? 'model' : 'user', parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message }] }
    ];

    // 2. Sanitize the list to ensure roles are alternating, merging if necessary
    const sanitizedContents = [];
    for (const msg of fullConversation) {
      const currentRole = (msg.role === 'system' || msg.role === 'user') ? 'user' : 'model';
      if (sanitizedContents.length > 0 && sanitizedContents[sanitizedContents.length - 1].role === currentRole) {
        // Merge with the previous message of the same role
        sanitizedContents[sanitizedContents.length - 1].parts[0].text += `\n\n---\n${msg.parts[0].text}`;
      } else {
        // Add new message
        sanitizedContents.push({ role: currentRole, parts: msg.parts });
      }
    }

    // 3. Call the API
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent({ contents: sanitizedContents, safetySettings, generationConfig: { maxOutputTokens: 300 } });
    const response = await result.response;
    const text = response.text();

    res.json({ text });

  } catch (error) {
    console.error('Error in /chat endpoint:', error);
    res.status(500).json({ error: 'Failed to communicate with AI' });
  }
});

// 評価エンドポイント
app.post('/evaluate', async (req, res) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings });
    const history = req.body.history || [];

    const historyText = history.map(msg => `${msg.role === 'ai' ? 'ゲームマスター' : 'あなた'}: ${msg.text}`).join('\n');

    const prompt = `あなたは、看護師向けのBLS/ACLSトレーニングの【親身で経験豊富な指導役】です。
学習者のモチベーションを高めることを第一に考え、常に丁寧で前向きな言葉を選んでください。しかし、評価内容はJRC蘇生ガイドラインと、このシミュレーション独自の特別ルールに沿って的確かつ具体的に分析してください。

**評価のポイント:**
1.  **スコアリング:** まず、学習者の行動全体を100点満点で採点してください。採点は0点からの【加点法】で行います。スコア自体は行動に基づいて厳密に評価してください。
    *   **採点基準:**
        *   初期対応 (20点): 迅速な応援要請（+10点）、迅速な胸骨圧迫（+10点）。
        *   BLS/ACLSアルゴリズム (40点): AEDの適切な使用（+15点）、2分ごとのリズムチェック（+15点）、質の高いCPRの継続（+10点）。
        *   チームマネジメント (30点): 到着したスタッフへの明確な役割指示（+15点）、リーダーシップの発揮（+15点）。
        *   独自ルールの遵守 (10点): 応援要請の使い分け（+5点）、権限の理解（+5点）。
    *   **重要:** 具体的な救命行動がほとんど見られない場合（例：「はい」のみなど）は、10点未満のスコアを付けてください。
2.  **フィードバックの書き方:**
    *   **「減点」という言葉は絶対に使わないでください。**
    *   フィードバックは、学習者を勇気づけ、次への挑戦を促すような、ポジティブなトーンで記述してください。

評価は以下のマークダウン形式で、丁寧かつ具体的に記述してください。

---
### **総合評価**
**総合スコア:** XX/100点
（学習者の頑張りを認めつつ、全体的なパフォーマンスについて簡潔に記述）

### **輝いていた点 (Good Points)**
*   （例：まず応援を呼べたこと、素晴らしい判断でした！これにより、10点を加点します。）

### **成長のポイント (Areas for Growth)**
*   （例：今回は胸骨圧迫が開始されませんでした。次回は、応援を呼んだ直後に圧迫を開始できると、さらに素晴らしい対応になりますね！)
*   （例：具体的な行動が「はい」のみでしたね。次は、まず「応援を呼ぶ」「胸骨圧迫を開始する」の２つに挑戦してみましょう！応援しています。）

### **次のステップへ (Next Steps)**
*   （例：BLSプロバイダーマニュアルを読み返し、救命の連鎖の最初のステップを再確認してみると、次回のシミュレーションがさらにスムーズになりますよ。）
---

**シミュレーション履歴:**
${historyText}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    res.json({ evaluation: text });
  } catch (error) {
    console.error('Error evaluating simulation:', error);
    res.status(500).json({ error: '評価の生成に失敗しました。' });
  }
});

app.listen(port, () => {
  console.log(`Backend server listening at http://localhost:${port}`);
});
