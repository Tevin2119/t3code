# Files Macroscope skips during code review and in Check Run Agents.

# This file REPLACES Macroscope's built-in defaults rather than extending them,

# so the defaults are reproduced below (from docs.macroscope.com, Code Review),

# followed by this repository's own entries at the end.

# ---- Macroscope defaults ----

# === Vendored / dependency directories ===

**/.git/**
**/**pycache**/**
**/.pytest_cache/**
**/.mypy_cache/**
**/.ruff_cache/**
**/venv/**
**/.venv/**
**/node_modules/**
**/site-packages/**
**/.pnpm-store/**
**/**Snapshots**/**
**/**snapshots**/**
**/.agents/skills/**
**/.claude/skills/**
**/.github/skills/**
**/bower_components/**
**/jspm_packages/**
**/.next/**
**/.svelte-kit/**
**/.nuxt/**
**/.output/**
**/.vercel/**
**/.angular/**
**/vendor/**
**/\_vendor/**
**/third_party/**
**/Pods/**
**/.bundle/**

# === Root-anchored ambiguous directories ===

build/**
out/**
env/**
ENV/**

# === Generated / build-output directories (match anywhere) ===

**/target/**
**/dist/**
**/generated/**
**/intermediates/**
**/generated_sources/**
**/generated-sources/**
**/generated-src/**
**/src/main/generated/**

# === Minified build output ===

**/_.min.js
\**/_.min.css
**/*.bundle.js

# === Yarn PnP loader files ===

**/.pnp.cjs
**/.pnp.loader.mjs

# === Generated protobuf / codegen files ===

**/_\_pb.d.ts
\**/__pb.js
**/_.pb.go
\**/__pb2.py
**/_\_pb2_grpc.py
\**/__pb2.pyi
**/_.grpc.swift
\**/_.pb.swift
**/_.sql.go
\**/_.designer.cs
**/_.g.dart
\**/_.pb.dart
**/_\_pb.rb
\**/_.d.ts
**/_.gen.ts
\**/_.gen.tsx
**/_.gen.js
\**/_.gen.jsx

# === Package manager files ===

**/go.mod
**/package.json
**/_.pbxproj
\**/_.xcstrings
**/_.strings
\**/_.properties
**/pom.xml
**/Package.swift
**/bun.lock
**/.eslintrc
**/.eslintignore

# === Lock / sum files ===

**/go.sum
**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
**/Package.resolved

# === Images ===

**/_.jpg
\**/_.jpeg
**/_.png
\**/_.gif
**/_.svg
\**/_.ico
**/_.webp
\**/_.bmp
**/*.tiff

# === Fonts ===

**/_.woff
\**/_.woff2
**/_.ttf
\**/_.eot
**/*.otf

# === Media ===

**/_.mp3
\**/_.mp4
**/_.wav
\**/_.avi
**/_.mov
\**/_.mkv
**/_.flac
\**/_.ogg
**/*.srt

# === Archives ===

**/_.zip
\**/_.tar
**/_.gz
\**/_.rar
**/_.7z
\**/_.bz2

# === Documents ===

**/_.pdf
\**/_.doc
**/_.docx
\**/_.xls
**/_.xlsx
\**/_.ppt
**/*.pptx

# === Data / serialized ===

**/_.db
\**/_.sqlite
**/_.sqlite3
\**/_.parquet
**/_.avro
\**/_.arrow
**/_.npy
\**/_.pkl
**/*.jsonl

# === ML models ===

**/_.onnx
\**/_.tflite
**/_.h5
\**/_.safetensors

# === Compiled / binary ===

**/_.exe
\**/_.dll
**/_.so
\**/_.dylib
**/_.bin
\**/_.pyc
**/_.class
\**/_.o
**/_.a
\**/_.wasm

# === Certificates / keys ===

**/_.cer
\**/_.pem
**/*.p12

# === Platform-specific / non-reviewable ===

**/_.stringsdict
\**/_.snap
**/_.adoc
\**/_.arb
**/_.lock
\**/_.po
**/_.fbx
\**/_.log
**/_.xib
\**/_.meta
**/_.kml
\**/_.prefab
**/_.eml
\**/_.csv
**/_.grpc.reflection
\**/_.js.map

# === Go ===

**/*_test.go

# === TypeScript / JavaScript ===

**/_.test.ts
\**/_.test.tsx
**/_.test.js
\**/_.test.jsx
**/_.test.mjs
\**/_.test.cjs
**/_.test.mts
\**/_.test.cts
**/_.spec.ts
\**/_.spec.tsx
**/_.spec.js
\**/_.spec.jsx
**/_.spec.mjs
\**/_.spec.cjs
**/_.spec.mts
\**/_.spec.cts
**/_.e2e.ts
\**/_.e2e.tsx
**/_.e2e.js
\**/_.e2e.jsx
**/_.e2e.mjs
\**/_.e2e.cjs
**/_.integration.ts
\**/_.integration.tsx
**/_.integration.js
\**/_.integration.jsx
**/_.integration.mjs
\**/_.integration.cjs
**/**tests**/**

# === Python ===

**/test__.py
\**/__test.py

# === Java / Kotlin ===

**/*Test.java
**/*Tests.java
**/*Spec.java
**/*IT.java
**/*ITCase.java
**/*Test.kt
**/*Tests.kt
**/*Spec.kt
**/*IT.kt
**/*ITCase.kt
**/src/test/java/**
**/src/test/kotlin/**
**/src/androidTest/**
**/src/integrationTest/**

# === Swift ===

**/*Tests.swift
**/*UITests.swift *_/*Tests/*_ *_/*UITests/*_

# === Rust ===

**/tests/_.rs
\**/__test.rs
\**/test_*.rs

# === Ruby ===

**/_\_test.rb
\**/__spec.rb
\**/test_*.rb

# === Generic test directories ===

**/test/**
**/tests/**
**/spec/**
**/specs/**
**/e2e/**

# ---- t3code ----

# Vendored read-only reference checkouts of upstream Effect and Alchemy

# (see scripts/lib/reference-repos.ts). Nothing imports from them; findings

# there belong upstream.

.repos/**
