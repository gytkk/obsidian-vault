# CLAUDE.md

## Project Overview

Obsidian 커스텀 플러그인 monorepo. `plugins/` 디렉토리에서 개발하고, `deploy.sh`로 vault에 빌드 결과물을 배포한다.

## Critical Rules

### Vault 보호

- **vault 디렉토리(e.g. `personal/`)는 반드시 `.gitignore`에 포함**되어야 한다. 개인 노트가 GitHub에 push되는 것을 방지하기 위함.
- vault 내부의 `.obsidian/plugins/` 디렉토리를 직접 수정하지 않는다. 항상 `plugins/`에서 개발하고 `./deploy.sh`로 배포한다.
- 새로운 최상위 디렉토리가 감지되면(git status에서 untracked directory), 사용자에게 용도를 확인한 뒤 필요 시 `.gitignore`에 추가한다. 임의로 staging하지 않는다.

### Package Manager

- `npm` 대신 `bun`을 사용한다.
- 예: `bun run build`, `bun install`, `bun run deploy`

### Development Workflow

1. `plugins/<plugin-name>/`에서 코드 수정
2. `bun run build:<plugin-name>` 또는 `bun run build`로 빌드
3. `bun run deploy:<plugin-name>` 또는 `bun run deploy`로 vault에 배포
4. Obsidian에서 플러그인 reload하여 확인

## Project Structure

```
~/obsidian/                  <- git repo root
├── plugins/                 <- 플러그인 소스코드 (여기서 개발)
│   ├── editable-view/
│   ├── event-inline-editor/
│   └── todo-inline-editor/
├── personal/                <- Obsidian vault (gitignored)
├── deploy.sh                <- 빌드 + vault에 아티팩트 복사
└── package.json             <- monorepo scripts
```
