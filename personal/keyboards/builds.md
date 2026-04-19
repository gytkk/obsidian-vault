---
tags:
  - build-index
---

# Builds

```editable-view
source: "keyboards/builds"
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
  - name: 비고
    type: input
```
