---
title: agent.md
summary: Aturan yang mengalahkan gaya, skill, dan memori.
order: 7
---

# agent.md

agent.md adalah file instruksi permanenmu. Ia masuk ke setiap chat dengan label *Agent instructions (highest priority after the system prompt)*.

## Isi yang cocok
- Aturan suara dan craft yang berlaku untuk semua tulisanmu.
- Etiket tools: baca sebelum menulis, tanya sebelum edit destruktif.
- Hal yang tidak boleh dilakukan model.

Yang **tidak** cocok: fakta cerita (story bible), alur kerja yang bisa dipakai ulang (skill), instruksi sekali pakai (pesan itu sendiri).

## Prioritas
1. System prompt dan aturan keamanan provider.
2. agent.md.
3. Konteks proyek.
4. Skill.
5. Gaya balasan.
6. Memori.
7. Pesanmu.

Saat dua aturan bertabrakan, yang lebih tinggi menang; model diminta menyebutnya dalam satu baris alih-alih memilih diam-diam.

## Mengedit
[[settings:agentmd]]: edit, lalu **Pratinjau prompt** untuk melihat hasil gabungan. **Pulihkan bawaan** memuat teks bawaan, templat memberi titik awal novelis, editor, atau minimal, dan penghitung menunjukkan karakter serta perkiraan token.

Draf bertahan saat berpindah bagian; **Buang** menghapusnya.

## Upgrade
Saat versi baru membawa bawaan yang lebih baik, agent.md diganti **hanya jika masih persis sama dengan teks bawaan lama**. Ubah satu karakter saja, tidak ada yang disentuh — toast sekali memberi tahu bahwa bawaannya berubah.
