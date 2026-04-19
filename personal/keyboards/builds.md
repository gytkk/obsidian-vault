---
tags:
  - build-index
---

# Builds

```dataview
TABLE WITHOUT ID
  file.link AS 빌드,
  보드,
  상태,
  날짜,
  비고
FROM "keyboards/builds"
SORT file.name ASC
```
