# ChipTime Results Viewer (Web)

Trang web hiển thị kết quả giải chạy đồng bộ từ **Firebase Realtime Database** — cùng cấu trúc dữ liệu mà app **iOS** upload (`{uid}/{event_key}/`).

## Tính năng

- Đọc `RACE_CONFIG` (tên giải, giờ xuất phát), `Athletes`, checkpoint `START` … `CP8` … `FINISH`
- Hỗ trợ nhiều cự ly (tab động) hoặc chế độ Ekiden
- Cập nhật realtime khi BTC upload từ iOS
- Chọn giải khi có nhiều sự kiện trên cùng tài khoản Firebase

## Cách sử dụng

1. Host / mở `index.html` (cần HTTPS hoặc localhost để Firebase hoạt động ổn định).
2. Truy cập với tham số URL (khuyến nghị khi dùng app iOS mới):

   - Một giải cụ thể:  
     `index.html?uid=FIREBASE_AUTH_UID&event=TEN_GIAI`  
     (`event` = `event_name` trong Setup, ký tự đặc biệt được thay `_` giống iOS)
   - Chỉ BTC (liệt kê mọi giải của uid):  
     `index.html?uid=FIREBASE_AUTH_UID`
   - Dữ liệu cũ (giải nằm ngay tại root RTDB):  
     `index.html?event=NO_NAME`

3. Không có tham số: trang tự quét root — nhận diện `{event}/` (legacy) hoặc `{uid}/{event}/` (iOS).

**Lấy `uid`:** Firebase Console → Authentication → User UID của tài khoản BTC đăng nhập trên iOS.

## Cấu trúc Firebase (iOS)

```
{sanitized_uid}/
  {sanitized_event_name}/
    RACE_CONFIG/   → event_name, start_time
    Athletes/      → bib, name, gen, age, distance, ...
    START|CP1|...|FINISH/{tagId}/lines/{md5}: "CP#time#rssi#ant"
```

## File chính

```
Web/
├── index.html
├── echiptime_logo.png
└── README.md
```

## Triển khai

Có thể triển khai lên bất kỳ hosting tĩnh nào như:
- GitHub Pages
- Netlify
- Vercel
- Hoặc bất kỳ web server nào
