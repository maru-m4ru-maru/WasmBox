# Copilot への指示

共通のルールは、リポジトリ直下の [AGENTS.md](../AGENTS.md) にあります。まずそれを読んでください。
設計と決定事項は [ARCHITECTURE.md](../ARCHITECTURE.md) です。

特に守ってほしいこと:

- 変更後は `npm run typecheck && npm test` を通す。
- TypeScript は **erasable なものだけ**（`enum`・`namespace`・コンストラクタの引数プロパティは使わない）。型の import は `import type`、import パスには `.ts` を付ける。
- 実行時の依存パッケージを増やさない。
- 利用者のデータ（overlay）を黙って捨てない。`src/storage/block-store.ts` の変更では、テストが本当に失敗を検出できるかも確認する。
- v86 などの外部ツールの挙動は、確認していないことを断定しない（🔬 を付ける）。
- コメントとエラーメッセージは日本語。
