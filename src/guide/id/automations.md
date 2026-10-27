---
title: Otomatisasi
summary: Saat ini terjadi, lakukan itu — tanpa menulis plugin.
order: 15
---

# Otomatisasi

Otomatisasi adalah aturan kapan/lalu kecil yang disimpan di [[settings:automations]]. Saat sesuatu terjadi di aplikasi, setiap aturan aktif untuk event itu menjalankan aksinya.

## Trigger

| Kapan | Kapan persisnya |
|---|---|
| App dimulai | sekali, setelah jendela siap |
| Chat dibuat | baris chat dibuat (dari sidebar, palette, menu, atau story agent) |
| Pesan dikirim | tepat sebelum request keluar, setelah pesan user tersimpan |
| Balasan AI diterima | setelah pesan asisten disimpan |
| Bab disimpan | setelah bab ditulis ke database |
| Proyek dibuat | dari form proyek atau Plot Smith |
| Skill diaktifkan | setiap kali skill dinyalakan di Pengaturan atau palette |

## Aksi

| Lalu | Parameter |
|---|---|
| Tampilkan toast | teks opsional (default: nama otomatisasi) |
| Kedipkan jendela | teks yang ditampilkan bersama kedipan |
| Tulis ke log plugin | — |
| Simpan memori | teks memori |
| Hapus semua memori | — (destruktif; menghapus seluruh memori jangka panjang) |
| Buka halaman | salah satu halaman aplikasi |
| Buat chat baru | judul chat opsional |
| Buka URL di browser | alamat `http(s)` |
| Pakai skill untuk pesan berikutnya | skill yang dipilih |

## Menjalankan dan memeriksa

- **Tes** menjalankan satu aturan itu saja — bukan semua aturan dengan trigger yang sama.
- Tiap baris menampilkan eksekusi terakhir (waktu, berhasil, pesan). Tombol **riwayat** menampilkan hingga 20 eksekusi di sesi ini.
- Riwayat hanya ada di memori; hilang setelah restart.

## Perlindungan loop

Aturan yang aksinya memicu ulang trigger-nya sendiri dilewati (misalnya *Balasan AI diterima → buat chat baru → pesan dikirim*), dan rantai tidak boleh lebih dari dua tingkat. Saat penjaga ini aktif, eksekusi dicatat sebagai dilewati, bukan diulang diam-diam.

Otomatisasi disimpan di database lokal bersama pengaturan lain dan ikut dalam backup penuh. Pakai **plugin** kalau butuh kode atau proses luar sungguhan; pakai **MCP** kalau model sendiri yang harus memilih tool.
