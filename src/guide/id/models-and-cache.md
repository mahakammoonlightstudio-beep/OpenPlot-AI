---
title: Model dan cache prompt
summary: Deteksi kemampuan, penyetelan per model, dan arti chip cache.
order: 4
---

# Model dan cache prompt

## Chip kemampuan
Setiap baris model menunjukkan kemampuannya dari tiga sumber:
1. **Preset dikenal** — fakta bawaan untuk model umum: konteks, output, reasoning, cache.
2. **Probe** — tombol *Verify* menanyakan langsung ke provider.
3. **Observasi** — angka usage dari balasan nyata.

Chip hanya petunjuk. Model yang mengaku tanpa reasoning tetap jalan; kontrol thinking menyembunyikan diri di mode `auto`.

## Penyetelan per model
[[settings:models]] → *Edit* membuka kartu model: context window, batas output, override temperature, dukungan reasoning, mode cache. Override disimpan per pasangan `provider::model`.

## Cache prompt
Sebagian provider memakai ulang awalan prompt yang tidak berubah dan menagihnya lebih murah. Footer chat menampilkan token ter-cache saat provider melaporkannya:

- `cache 0%` — tidak ada yang dipakai ulang.
- `cache 62%` — sebagian besar awalan prompt dari cache.

Cache bergantung pada awalan yang stabil. Mengedit pesan lama atau mengganti system prompt membatalkannya — itu wajar, bukan bug.
