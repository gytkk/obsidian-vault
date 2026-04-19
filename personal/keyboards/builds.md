---
tags:
  - build-index
---

# Builds

```editable-view
source: "keyboards/builds"
template: "_templates/keyboard-build.md"
defaults:
  상태: current
titlePattern: "{{보드.label}} - Current"
newFileName: "Untitled"
fields:
  - name: 보드
    type: relation
    source: "keyboards/boards"
  - name: 제작사
    type: lookup
    relation: 보드
    field: 제작사
  - name: 레이아웃
    type: lookup
    relation: 보드
    field: 레이아웃
  - name: 상태
    type: dropdown
    options: [current, archived]
  - name: PCB
    type: input
  - name: 보강판
    type: input
  - name: 스위치
    type: relation-multi
    source: "keyboards/switches"
  - name: 키캡
    type: relation-multi
    source: "keyboards/keycaps"
  - name: 비고
    type: input
```
