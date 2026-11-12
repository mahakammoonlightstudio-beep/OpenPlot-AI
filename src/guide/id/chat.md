---
title: Dasar chat
summary: Mengirim, berhenti, mengulang, dan override per chat.
order: 2
---

# Dasar chat

## Mengirim
- `Enter` mengirim; `Shift+Enter` baris baru.
- Composer tumbuh sampai sekitar delapan baris, lalu menggulir.
- `Esc` menutup popover model atau skill.

## Berhenti dan mengulang
Saat balasan mengalir tombol kirim berubah menjadi **Stop**. Berhenti menyimpan teks yang sudah ada — itu pesan sungguhan, bukan buangan.

**Regenerate** menjalankan ulang giliran asisten terakhir. Balasan sebelumnya tetap ada di menu pesan agar kamu bisa membandingkan.

## Override per chat
Header menampilkan model, meter token, dan chip proyek. Setiap chat menyimpan:
- model dan override temperature,
- system prompt (menggantikan yang global hanya untuk chat ini),
- pengaturan thinking dan anggarannya,
- goal sesi — instruksi tersemat yang masuk ke setiap prompt,
- pengecualian skill per chat.

## Merapikan
- **Folder** mengelompokkan chat di sidebar, terpisah untuk Chat dan Agent. Klik folder untuk membukanya dan pakai `+` di sana untuk mulai chat di dalamnya; tarik chat mana pun ke folder untuk memasukkannya, dan ke judul **Chat** untuk mengeluarkannya lagi.
- **Pin** menahan chat di atas.
- **Ganti nama** dari baris chat atau header.
- **Pindah cepat** — `Ctrl+P` membuka palette khusus chat dan proyek; ketik sebagian judul, nama proyek, atau workspace lalu tekan `Enter`.
- Menghapus chat menghapus pesan dan file terlampirnya. Tidak ada undo — ekspor dulu lewat [[settings:data]] bila chat itu penting.

## Apa yang benar-benar dilihat model
Buka [[settings:agentmd]] dan tekan **Pratinjau prompt** untuk melihat system prompt persis untuk pesan berikutnya: sistem, agent.md, proyek, memori, skill, goal, gaya, tools, lampiran.
