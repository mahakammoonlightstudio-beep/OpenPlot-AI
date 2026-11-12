---
title: Privasi dan data
summary: Apa yang tetap lokal, apa yang dikirim, dan di mana filenya.
order: 17
---

# Privasi dan data

## Lokal secara bawaan
Semua tersimpan di file SQLite pada folder data pengguna, terlihat di [[settings:data]]: chat, pesan, lampiran, proyek, story bible, bab, prompt, skill, pengaturan.

Tanpa analitik, tanpa telemetri, tanpa akun.

## Yang keluar dari mesin
Hanya permintaan yang kamu kirim: system prompt (bisa memuat agent.md, konteks proyek, skill, dan file terlampir), riwayat percakapan, dan pesanmu. Semuanya langsung ke provider yang kamu atur — tidak ada proxy di antaranya.

Gambar dan file dikirim sebagai teks. File biner ditolak, bukan diunggah.

## API key
Key provider dan kunci web-search disimpan terenkripsi saat vault kredensial OS tersedia; jika tidak, aplikasi mengatakannya di [[settings:data]]. Kunci web-search tidak pernah masuk ke antarmuka — UI hanya menunjukkan apakah key sudah tersimpan. Key tidak pernah masuk ke ekspor, log, atau pesan error.

Variabel lingkungan MCP berbeda: editor MCP perlu menampilkan dan mengeditnya, jadi nilainya tinggal di database lokal, bukan di vault OS. Salinan portabel mengosongkannya, tapi untuk rahasia produksi berumur panjang, pakai disk yang terenkripsi OS.

## Menghapus
*Reset semua data* menghapus setiap baris dan isi file. Backup saat migrasi skema (`.bak`) tetap ada di sebelah database — hapus manual bila ingin bersih total.
