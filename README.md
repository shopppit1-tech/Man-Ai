# Man-Ai — Chat Gemini

Situs chat tanpa login yang didukung Google Gemini API. Frontend disajikan oleh backend Node.js kecil yang menjaga kunci Gemini tetap di server, tidak di halaman publik atau Git.

Ini adalah chat mandiri berbasis Gemini, bukan layanan resmi Manus. Selain jawaban, draf, dan rencana, situs menyediakan aksi tertentu untuk GitHub, Supabase, dan Render yang selalu memerlukan konfirmasi eksplisit; ini bukan akses ke seluruh alat Manus.

## Jalankan secara lokal

Persyaratan: Node.js 20 atau yang lebih baru dan kunci Gemini API dari [Google AI Studio](https://aistudio.google.com/apikey).

1. Salin `.env.example` menjadi `.env`, lalu isi `GEMINI_API_KEY` dengan kunci utama. Secara opsional, isi `GEMINI_API_KEY_BACKUP` dan `GEMINI_API_KEY_BACKUP_2` sebagai kunci cadangan. Jangan commit file `.env`.
2. Jalankan server dengan `npm start`.
3. Buka `http://localhost:3000`.

Server juga menerima `GOOGLE_API_KEY` sebagai nama alternatif untuk kunci utama. Jika suatu kunci ditolak atau kuotanya habis, server akan mencoba kunci cadangan yang telah diatur secara berurutan. `GEMINI_MODEL` dapat digunakan untuk mengganti model bawaan (`gemini-3.8-flash`).

## Deploy

Deploy repo ini sebagai layanan web Node.js, bukan hanya hosting statis GitHub Pages. Atur perintah start ke `npm start`, lalu masukkan `GEMINI_API_KEY` dan, jika diperlukan, `GEMINI_API_KEY_BACKUP` serta `GEMINI_API_KEY_BACKUP_2` pada pengaturan secret/environment variable di layanan hosting. Aplikasi menggunakan `PORT` yang diberikan oleh host. Jangan pernah memasukkan kunci API ke `index.html`, `script.js`, file `.env` publik, atau commit GitHub.

## Penggunaan tanpa login dan batas pemakaian

Pengunjung dapat memakai chat tanpa login. Server membatasi panjang prompt hingga 8.000 karakter, maksimal 12 pesan per menit untuk tiap IP, serta 200 pesan per hari secara global sebagai nilai bawaan. Atur `GEMINI_DAILY_LIMIT` untuk mengubah batas harian. Batas dalam memori ini akan direset saat layanan dimulai ulang dan hanya merupakan perlindungan sederhana; untuk penggunaan produksi, tambahkan pembatas pemakaian bersama yang persisten, pemantauan penggunaan, dan batas pengeluaran pada proyek Google API. Penggunaan Gemini tetap mengikuti ketersediaan model, kuota, dan pengaturan tagihan akun.

Browser menyimpan ID interaksi Gemini hanya di memori untuk pertanyaan lanjutan. Situs tidak menyimpan riwayat chat di database, tetapi Gemini Interactions API dapat menyimpan interaksi sesuai kebijakan retensi akun Google AI; jangan kirim data sensitif.


## Konektor dan aksi dengan konfirmasi

Man-Ai mendukung tiga aksi melalui tool-calling Gemini: membuat repository GitHub baru (selalu private), menyisipkan satu row JSON ke tabel Supabase yang terlihat oleh publishable/anon key, dan memicu deploy pada service Render yang terhubung tanpa membersihkan cache. Gemini hanya mengusulkan satu aksi; halaman menampilkan target dan payload persisnya. Aksi tidak berjalan sampai pengguna menekan **Konfirmasi dan jalankan**. Proposal terikat ke cookie sesi browser HttpOnly/SameSite dan fingerprint kredensial konektor yang dipakai saat persetujuan dibuat; target akun/proyek ditampilkan pada kartu konfirmasi. Proposal disimpan sementara di memori satu proses server selama lima menit dan hanya dapat digunakan sekali. Jalankan satu instance Node.js; untuk multi-instance diperlukan penyimpanan state bersama.

Kredensial dimasukkan pengguna dan disimpan sementara di `sessionStorage` browser, lalu dikirim ke server hanya untuk permintaan yang diperlukan. Server tidak mencatat atau menyimpan token di database. Tutup tab untuk menghapus sesi konektor. Gunakan perangkat tepercaya. API key Render dapat memberi akses luas, jadi lindungi seperti password.

- GitHub: gunakan fine-grained personal access token dengan metadata baca dan izin **Repository creation (write)**. Repo yang dibuat bersifat private.
- Render: gunakan API key. Hanya endpoint daftar service dan trigger deploy yang dipanggil. Deploy selalu menggunakan mode `build_and_deploy` dan `clearCache=do_not_clear`.
- Supabase: gunakan URL proyek dan publishable/anon key. `service_role` dan `sb_secret_` key ditolak. Agar insert berhasil, tabel harus mengizinkan operasi `INSERT` melalui GRANT dan kebijakan RLS; jika tidak, Supabase akan menolak aksi.

Konektor harus disambungkan di panel Konektor sebelum dipakai Gemini. Deploy aplikasi tetap memerlukan layanan Node.js yang menjalankan `npm start`; GitHub Pages statis tidak dapat menjalankan API proxy ini. Jangan tempelkan token ke prompt atau commit ke Git.


## Unduh HTML

Jika prompt meminta kode atau file HTML, Gemini akan membalas dengan satu blok `html`. Antarmuka menambahkan tombol untuk mengunduhnya sebagai file `.html`; kode ditampilkan sebagai teks, bukan dijalankan di halaman. Periksa file sebelum membukanya.
