# わんコメ YouTube 配信自動セット プラグイン 設計書（ドラフト）

作成: 2026-10-26

## 1. 目的

YouTube で配信を始めたら、わんコメの YouTube 枠の URL を「今配信中の枠」（`https://www.youtube.com/watch?v=<動画ID>`）に自動で書き換え、配信のたびに URL を貼り替える手間をなくす。

他の配信者にも配布する前提で作る。

## 2. 背景（2026-10-26 に実測）

| 試したこと | 結果 |
|---|---|
| わんコメに `https://www.youtube.com/@<ハンドル>/live` | 予約枠が公開だと、YouTube が予約枠のほうを返す（配信中の枠ではない） |
| 予約枠を限定公開にして `/live` | YouTube は配信中の枠を返すが、わんコメはチャット欄の読み込みに失敗する（ログに `Failed to load URL: https://www.youtube.com/live_chat?continuation=...`） |
| わんコメに `https://www.youtube.com/watch?v=<動画ID>` | コメントが正常に取れる |
| わんコメに `https://www.youtube.com/@<ハンドル>` | チャンネルトップ扱いでコメントは取れない |

→ 「配信中の動画 ID を見つけて `watch?v=` 形式で入れる」ことが必要。

## 3. 全体の流れ

```
[YouTube Data API v3（公式）] <--HTTPS-- [プラグイン（わんコメ内の Node）] --HTTP--> [わんコメ HTTP API localhost:11180]
                                                  ^
                                   [設定画面 localhost:11180/plugins/<uid>/index.html]
```

1. 一定間隔（既定 60 秒）で、自分のチャンネルの「配信中」の動画を探す
2. 見つかった動画 ID が、対象の枠の今の URL と違えば、`PUT /api/services/{id}` で URL を書き換える
3. 枠が接続中なら、つなぎ直す（OFF → ON）※ 必要かどうかは実測で確認する（§8）

## 4. 配信中の枠の探し方

規約上の理由で YouTube Data API v3（公式）を使う。わんコメ利用規約の禁止事項 17「非公開もしくは許諾のないAPIを用いて連携を行うこと」に当たらないようにするため。`/live` や配信一覧ページの HTML 解析はしない。

| 手順 | API | 利用枠（quota） | 頻度 |
|---|---|---|---|
| ハンドル → チャンネル ID・アップロード再生リスト ID | `channels.list?part=id,contentDetails&forHandle=@xxx` | 1 | 設定変更時に 1 回（結果を保存） |
| 最近の動画 ID | `playlistItems.list?part=contentDetails&playlistId=UU...&maxResults=10` | 1 | 毎回 |
| 配信中かどうか | `videos.list?part=snippet,liveStreamingDetails&id=...` | 1 | 毎回 |

- 判定: `liveStreamingDetails.actualStartTime` があり、`actualEndTime` がない動画を「配信中」とする。複数あれば `actualStartTime` が新しいもの
  - `snippet.liveBroadcastContent` は使わない。2026-10-26 の実測で、配信開始後（`actualStartTime` あり）も `"upcoming"` のまま返ってきたため（反映が遅れる）
- 60 秒ごとで 1 日 2,880 units（無料枠 10,000 units/日 の範囲内）
- `search.list`（1 回 100 units）は使わない
- 2026-10-26 確認: 公開の予約枠はアップロード再生リストに入る。配信を始めても同じ動画 ID のまま
- 限定公開の動画は API キーでは見えない → 対象は公開配信のみ（README に書く）

API キーは利用者が各自で発行する（配布物にキーを入れない）。

## 5. 設定項目（プラグインの store に保存）

| キー | 型 | 既定 | 内容 |
|---|---|---|---|
| `apiKey` | string | "" | YouTube Data API キー。設定画面の GET では返さない（「設定済み」かどうかだけ返す） |
| `channel` | string | "" | `@ハンドル` またはチャンネル URL |
| `serviceId` | string | "" | 書き換える わんコメ の枠の ID（設定画面で一覧から選ぶ） |
| `intervalSec` | number | 60 | 確認間隔。下限 60 |
| `enabled` | boolean | true | 自動セットを使うか |

内部状態（保存）: 解決済みの `channelId` / `uploadsPlaylistId`、最後にセットした動画 ID、最後のエラー。

## 6. プラグインの構成（わんコメ 5.2+ / Node 20+）

- 配置: `%APPDATA%\onecomme\plugins\<フォルダ>\plugin.js` + 設定画面の静的ファイル
- `plugin.js` は CommonJS（`module.exports = plugin`）
- `init({ dir, store })` でタイマー開始、`destroy()` で停止
- 設定画面: `http://localhost:11180/plugins/<uid>/index.html`。`/api/plugins/<uid>` を `request()` で処理（GET: 設定と状態 / PUT: 設定保存 / POST: 今すぐ確認）
- 設定画面は外部 CDN を使わない（素の HTML/JS）
- `permissions`: 受け取るイベントは不要なので最小限（必須項目のため空配列で動くか確認）

コードの層:

- `domain/`: 純粋関数（チャンネル入力の解析、API レスポンスから配信中の動画を選ぶ、書き換えが必要かの判定）→ フィクスチャで TDD
- `infra/`: YouTube API クライアント、わんコメ API クライアント（`fetch` を注入してテストで差し替え）
- `app/`: 定期実行ループ（多重実行防止、失敗時の待ち時間の延長）
- `plugin.ts`: わんコメとの接続のみ

## 7. エラーと安全

- わんコメを落とさない: タイマーと `request()` は必ず try/catch
- 外部レスポンスは型ガードで検証してから使う
- API キーはログ・設定画面の GET・エラーメッセージに出さない
- 失敗が続いたら間隔を延ばす（最大 10 分）。quota 超過（403 `quotaExceeded`）なら翌日まで止める
- わんコメ API は `127.0.0.1:11180` 固定。外部へは `www.googleapis.com` にしか通信しない
- 対象の枠が消えていたら何もせず、状態欄にエラーを出す

## 8. 実測で確かめること

- [x] `PUT /api/services/{id}` に `{ "url": ... }` だけ送ると URL だけ変わる（2026-10-26 確認。`POST` で作る時は `id` 必須）
- [ ] 接続中の枠の URL を変えたとき、わんコメが自動でつなぎ直すか（しないなら `enabled` を false → true）
- [x] 予約枠・配信中の枠がアップロード再生リストに入るか（入る。2026-10-26 確認）
- [ ] 配信開始から `actualStartTime` が API に出るまでの遅れ
- [ ] `permissions: []` で読み込めるか

## 9. 配布に向けて（後で）

- ライセンスを決める
- README: API キーの発行手順、免責（わんコメ・YouTube とは無関係の非公式ツール）
- YouTube API サービス利用規約・Google のプライバシーポリシーへの同意・リンク表記の要否を確認
- わんコメ公式と誤解されない名前（わんコメのロゴは使わない）
- 依存パッケージ候補（未導入・要相談）: typescript / esbuild / vitest（いずれも開発用で配布物に入らない）。`@onecomme.com/onesdk` はライセンスが独自（OneComme-Use-Only）なので使わず、必要な型は自分で書く
