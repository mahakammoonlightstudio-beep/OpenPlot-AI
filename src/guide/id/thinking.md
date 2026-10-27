---
title: Thinking dan reasoning
summary: Anggaran reasoning, ke mana outputnya, dan cara menyetelnya.
order: 5
---

# Thinking dan reasoning

Model yang mendukung reasoning bisa memakai token sebelum menjawab. OpenPlot menampilkannya sebagai **Thinking**.

## Kontrol
Ikon otak di composer punya tiga keadaan: mati, nyala, dan *auto*. Dengan `thinkingUi = auto`, model yang tidak bisa reasoning tidak melihat kontrol ini sama sekali.

## Anggaran
Anggaran adalah batas token reasoning untuk chat ini, dibatasi context window model. Anggaran lebih besar tidak otomatis lebih baik: ia menambah latensi dan biaya, dan sebagian besar tugas selesai jauh sebelum batas.

## Ke mana outputnya
Reasoning mengalir ke blok yang bisa dilipat di atas balasan. `thinkingDisplay` menentukan:
- **auto** — terbuka saat mengalir, terlipat saat jawaban mulai.
- **expanded** / **collapsed** — dikunci.

Teks reasoning disimpan bersama pesan dan tidak pernah dimasukkan kembali ke prompt berikutnya.

## Setelan praktis
| Tugas | Anggaran |
| --- | --- |
| Edit cepat, chat | mati |
| Perencanaan, kritik | 1–2k |
| Masalah kontinuitas atau plot | 4k+ |
