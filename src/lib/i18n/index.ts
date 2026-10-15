/**
 * UI copy lives here so the interface can be translated by adding one object.
 * `vi` is the default language; unknown keys fall back to the key itself so a
 * missing string is visible instead of blank.
 */

export type Lang = "vi" | "en";

export const vi = {
  "app.name": "Second Brain",
  "app.tagline": "Bộ nhớ cá nhân chạy trên máy của bạn",

  "nav.dashboard": "Tổng quan",
  "nav.notes": "Ghi chú",
  "nav.library": "Thư viện",
  "nav.search": "Tìm kiếm",
  "nav.chat": "Hỏi đáp",
  "nav.plays": "Tự động hoá",
  "nav.connectors": "Kết nối",
  "nav.import": "Nhập dữ liệu",
  "nav.timeline": "Dòng thời gian",
  "nav.graph": "Bản đồ tri thức",
  "nav.settings": "Cài đặt",

  "action.save": "Lưu",
  "action.cancel": "Huỷ",
  "action.delete": "Xoá",
  "action.edit": "Sửa",
  "action.create": "Tạo mới",
  "action.search": "Tìm",
  "action.sync": "Đồng bộ",
  "action.syncNow": "Đồng bộ ngay",
  "action.run": "Chạy",
  "action.runNow": "Chạy ngay",
  "action.connect": "Kết nối",
  "action.disconnect": "Ngắt kết nối",
  "action.upload": "Tải lên",
  "action.retry": "Thử lại",
  "action.open": "Mở",
  "action.copy": "Sao chép",
  "action.dismiss": "Bỏ qua",
  "action.close": "Đóng",
  "action.refresh": "Làm mới",
  "action.send": "Gửi",
  "action.newChat": "Cuộc trò chuyện mới",
  "action.export": "Xuất dữ liệu",
  "action.import": "Nhập",
  "action.backfill": "Tạo embedding còn thiếu",
  "action.viewAll": "Xem tất cả",

  "state.loading": "Đang tải…",
  "state.empty": "Chưa có dữ liệu",
  "state.none": "Không có",
  "state.saving": "Đang lưu…",
  "state.saved": "Đã lưu",
  "state.error": "Có lỗi xảy ra",
  "state.running": "Đang chạy",
  "state.done": "Hoàn tất",
  "state.failed": "Thất bại",
  "state.connected": "Đã kết nối",
  "state.disconnected": "Chưa kết nối",
  "state.paused": "Tạm dừng",

  "dashboard.title": "Tổng quan",
  "dashboard.quickCapture": "Ghi nhanh",
  "dashboard.quickCaptureHint": "Viết một ghi chú, dán liên kết hoặc nội dung cần lưu…",
  "dashboard.recent": "Vừa thêm gần đây",
  "dashboard.activity": "Hoạt động",
  "dashboard.jobs": "Tác vụ nền",
  "dashboard.stats": "Kho tri thức",
  "dashboard.needsSetup": "Chưa cấu hình AI",
  "dashboard.needsSetupHint": "App vẫn chạy tốt ở chế độ tìm kiếm từ khoá. Thêm key ở Cài đặt để bật hỏi đáp có trích dẫn.",

  "notes.title": "Ghi chú",
  "notes.new": "Ghi chú mới",
  "notes.untitled": "Chưa có tiêu đề",
  "notes.tags": "Thẻ",
  "notes.links": "Liên kết",
  "notes.backlinks": "Được nhắc tới ở",
  "notes.body": "Nội dung",
  "notes.preview": "Xem trước",

  "library.title": "Thư viện",
  "library.source": "Nguồn",
  "library.allSources": "Tất cả nguồn",
  "library.chunks": "Đoạn",
  "library.detail": "Chi tiết tài liệu",

  "search.title": "Tìm kiếm",
  "search.placeholder": "Tìm trong toàn bộ bộ nhớ…",
  "search.hybrid": "Lai (từ khoá + ngữ nghĩa)",
  "search.keyword": "Từ khoá",
  "search.semantic": "Ngữ nghĩa",
  "search.filters": "Bộ lọc",
  "search.from": "Từ ngày",
  "search.to": "Đến ngày",
  "search.mode": "Cách tìm",
  "search.noResults": "Không tìm thấy kết quả nào",
  "search.offline": "Chế độ từ khoá: chưa có model embedding nên tìm kiếm ngữ nghĩa tạm tắt.",

  "chat.title": "Hỏi đáp với bộ nhớ",
  "chat.placeholder": "Hỏi bất cứ điều gì về dữ liệu của bạn…",
  "chat.scope": "Phạm vi",
  "chat.scopeAll": "Toàn bộ bộ nhớ",
  "chat.scopeNotes": "Chỉ ghi chú",
  "chat.citations": "Nguồn tham chiếu",
  "chat.noCitations": "Chưa có nguồn nào được dùng",
  "chat.history": "Lịch sử",
  "chat.needKey": "Cần cấu hình model để trò chuyện",
  "chat.needKeyHint": "Vào Cài đặt để thêm API key hoặc trỏ tới Ollama/LM Studio đang chạy trên máy.",

  "connectors.title": "Kết nối nguồn dữ liệu",
  "connectors.subtitle": "Đồng bộ email, lịch, chat và tài liệu về bộ nhớ cá nhân của bạn.",
  "connectors.oauthHint": "Bạn cần tự đăng ký OAuth app cho từng dịch vụ và dán Client ID/Secret — xem docs/connectors.md.",
  "connectors.lastSync": "Lần đồng bộ cuối",
  "connectors.log": "Nhật ký đồng bộ",
  "connectors.items": "mục",

  "import.title": "Nhập dữ liệu",
  "import.subtitle": "Tải tệp lên, dán liên kết, đồng bộ thư mục hoặc nhập bản export từ dịch vụ khác.",
  "import.folder": "Thư mục trên máy",
  "import.folderHint": "Ví dụ: vault Obsidian hoặc thư mục tài liệu. Đồng bộ theo thời gian sửa đổi.",
  "import.url": "Liên kết",
  "import.files": "Tệp",
  "import.paste": "Văn bản dán",
  "import.supported": "Định dạng hỗ trợ",

  "plays.title": "Tự động hoá",
  "plays.subtitle": "Các quy trình dựng sẵn: tổng hợp tuần, chuẩn bị họp, nhắc việc còn dang dở.",
  "plays.lastRun": "Lần chạy gần nhất",
  "plays.output": "Kết quả",
  "plays.history": "Lịch sử chạy",

  "timeline.title": "Dòng thời gian",
  "timeline.subtitle": "Mọi thứ bạn đã lưu, theo thứ tự thời gian.",

  "graph.title": "Bản đồ tri thức",
  "graph.subtitle": "Người, dự án và chủ đề xuất hiện cùng nhau trong bộ nhớ của bạn.",

  "settings.title": "Cài đặt",
  "settings.ai": "Nhà cung cấp AI",
  "settings.aiHint": "Dùng chung giao thức OpenAI-compatible: OpenAI, OpenRouter, Groq, Azure hoặc Ollama/LM Studio trên máy.",
  "settings.baseUrl": "Base URL",
  "settings.apiKey": "API key",
  "settings.chatModel": "Model hội thoại",
  "settings.embedModel": "Model embedding",
  "settings.data": "Dữ liệu",
  "settings.tokens": "API token",
  "settings.maintenance": "Bảo trì",
  "settings.diagnostics": "Chẩn đoán",
  "settings.savedKey": "Key đã lưu (để trống nếu giữ nguyên)",
} as const;

export type UiKey = keyof typeof vi;

const BUNDLES: Record<Lang, Partial<Record<UiKey, string>>> = { vi, en: {} };

export function t(key: UiKey, lang: Lang = "vi"): string {
  return BUNDLES[lang][key] ?? vi[key] ?? key;
}

export function makeTranslator(lang: Lang = "vi") {
  return (key: UiKey): string => t(key, lang);
}
