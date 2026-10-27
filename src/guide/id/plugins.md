---
title: Plugin
summary: Ekstensi JS lokal, hook-nya, dan batasannya.
order: 14
---

# Plugin

Plugin adalah potongan JavaScript lokal yang disimpan di aplikasi dan dijalankan di proses utama. Plugin punya akses yang sama dengan aplikasi: pasang hanya kode yang kamu tulis atau baca.

## Bentuk
```js
context.registerHook('message:new', (payload) => {
  context.log('Pesan baru di chat ' + payload.chatId);
});
context.registerCommand('halo', () => {
  context.toast('Halo dari plugin!');
});
```

## Hook
Yang dijalankan aplikasi: `app:ready` (jendela siap), `chat:new` (baris chat dibuat), `message:new` (pesan disimpan — user, asisten, atau error).

Error dari satu handler ditangkap dan ditulis ke log plugin itu; plugin yang rusak tidak pernah merusak chat atau database.

## Perintah
`context.registerCommand(name, fn)` menambah perintah yang dijalankan sesuai permintaan:

- tampil di baris plugin pada Pengaturan → Plugin, dengan satu tombol per perintah;
- bisa dicari di command palette (`Ctrl/Cmd+K`) sebagai *nama plugin: perintah*.

**Muat ulang semua plugin** membaca ulang setiap plugin aktif dari database setelah kamu mengedit kode, jadi tidak perlu restart. Menyimpan dari editor melakukan hal yang sama secara otomatis.

## Keamanan
- Plugin nonaktif tidak pernah dimuat — bukan dimuat lalu diblokir.
- Kode plugin bisa membaca file, mengakses jaringan, dan menulis database. `new Function` adalah batas kenyamanan, bukan batas keamanan.
- Jaga hook tetap cepat: semuanya berjalan sinkron di proses utama.

Lihat `docs/PLUGIN_API.md` di repositori untuk permukaan `context` lengkapnya.

Kalau kamu hanya butuh "saat event ini, lakukan itu" tanpa menulis kode, pakai **otomatisasi** — triggernya sama, aksinya sudah tersedia.
