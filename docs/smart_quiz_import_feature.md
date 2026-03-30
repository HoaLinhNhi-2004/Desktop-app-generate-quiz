# Tài Liệu Đặc Tả Tính Năng: Smart Quiz Import (Nhập Câu Hỏi Khôn Ngoan)

## 1. Tổng Quan Tính Năng (Feature Overview)
- **Mục tiêu:** Cho phép người dùng tải lên các file (Excel, Word, PDF) chứa **sẵn** một danh sách câu hỏi và câu trả lời. Hệ thống sẽ tự động quét, nhận diện (parse) cấu trúc câu hỏi có trong file và chuyển đổi chúng thành định dạng Quiz nội bộ của ứng dụng.
- **Vấn đề giải quyết:** Hiện tại hệ thống chỉ hỗ trợ việc *tạo mới câu hỏi* từ tài liệu học tập (Study Material) dựa trên Prompt cứng của Gemini (sinh ra mười câu hỏi mới). Nếu đưa file chứa câu hỏi sẵn có vào hệ thống hiện tại, AI sẽ có xu hướng tóm tắt đoạn text đó và sáng tác ra các câu hỏi hỏi về... chính các câu hỏi kia, hoặc giới hạn số lượng câu do biến `num_questions`.
- **Lợi ích:** Tái sử dụng được kho tàng đề thi phong phú đa dạng ở các định dạng bất kỳ mà không cần người dùng phải format theo template chuẩn trước khi đăng tải.

## 2. Luồng Hoạt Động (Workflow)
1. **Người dùng (Frontend):** Tại giao diện **Create Quiz (Tab Tạo trắc nghiệm)**, người dùng tích chọn các tài liệu (files) mà họ đã upload.
2. **Chọn Chế Độ:** Ngay tại phần tuỳ chọn (kế bên bảng cấu hình), hệ thống có hai lựa chọn (Mode):
   - `"Tạo trắc nghiệm từ tài liệu"` (Generate)
   - `"Q&A Document (Trích xuất nguyên bộ câu hỏi từ file)"` (Import)
3. **Gọi API (Frontend -> Backend):** Gửi request tạo quiz kèm tham số mode `action="import"`.
4. **Trích xuất Text (Backend):** File được xử lý qua `pdfplumber`, `python-docx` hoặc `pandas` để lấy chuỗi văn bản thô.
5. **AI Extraction Parsing:** Văn bản thô được đẩy cho Gemini kèm theo một **Extraction Prompt** đặc biệt. LLM nhận diện cấu trúc câu hỏi và trích xuất nguyên vẹn không làm thay đổi nội dung, xuất ra JSON.
6. **Lưu trữ & Trả kết quả:** Lưu vào Database (`QuizSet`, `Question`) và mở trang thi/chỉnh sửa để người xem duyệt lại.

## 3. Các Thay Đổi Phía Frontend (Frontend Changes)
- **Cập nhật UI màn hình `Create Quiz` (`FolderDetailPage.tsx`):**
  - Tại Tab **Create Quiz** (nơi có Component chọn tài liệu và `QuizConfigPanel`), bổ sung một Switch hoặc Radio selection: `Tạo từ tài liệu` vs `Trích xuất từ file đề thi`.
  - **Xử lý UX:** Khi người dùng chọn chế độ `Trích xuất từ file đề thi` (Import), giao diện cần **ẩn (hoặc disable)** bảng `QuizConfigPanel` (số lượng câu hỏi, loại câu hỏi, độ khó). Số lượng và loại câu sẽ phụ thuộc hoàn toàn vào những gì hệ thống tự động nhận diện được từ trong file.
- **Cập nhật API Layer:** Truyền thêm state `{ action: 'import' }` vào mutation API gọi lên server.

## 4. Các Thay Đổi Phía Backend (Backend Changes)
- **Routes (`quiz/routes.py`):**
  - Xử lý tham số mới `action`.
  - Nếu `action == "generate"`, gọi hàm `generate_quiz()` truyền thống ở bản hiện tại.
  - Nếu `action == "import"`, điều hướng sang một hàm xử lý mới: `import_quiz_from_text()`.
- **Text Processor:**
  - Vẫn dùng lại logic trích xuất của hàm `_extract_combined_text()`. Tuy nhiên, cẩn trọng với việc filter boilerplate (vì trong đề thi các ký tự như số thứ tự (1,2,3), ký hiệu (A,B,C,D) rất quan trọng, không được lọc nhầm).
- **AI Generator (`quiz_generator.py`):**
  - Tạo hàm `_build_import_prompt(text: str)` thay vì `_build_prompt`.

## 5. Cấu Trúc Prompt Mới (Prompt Engineering cho Extract Mode)
Đây là phần quan trọng nhất để tính năng này hoạt động đúng.

```text
Bạn là một chuyên gia nhận diện và trích xuất dữ liệu.
Nhiệm vụ của bạn là đọc nội dung văn bản dưới đây, nhận diện TẤT CẢ các câu hỏi kèm theo câu trả lời (nếu có) và xuất chúng ra định dạng JSON.

HƯỚNG DẪN QUAN TRỌNG:
1. KHÔNG sáng tác hay tóm tắt nội dung. Hãy GIỮ NGUYÊN văn bản của câu hỏi và các đáp án.
2. NHẬN DIỆN số lượng câu hỏi tùy ý. Bạn phải bóc tách TẤT CẢ câu hỏi có trong văn bản (không giới hạn 10 câu).
3. SUY LUẬN đáp án đúng: Nếu trong văn bản đáp án đúng được làm nổi bật (bôi đậm, gạch dưới, có dấu *, hoặc nằm ở phần "Đáp án" cuối file), hãy tự động gán đáp án đúng vào id tương ứng. Nếu không thể suy luận được đáp án, hãy đánh dấu phần "correctAnswerId" là rỗng (hoặc null).
4. Phân loại câu hỏi: Dựa vào cấu trúc, nếu câu có nhiều lựa chọn (A,B,C,D) hãy gán type = "multiple-choice".

ĐẦU RA:
Trả về duy nhất một mảng JSON tuân theo cấu trúc sau, không kèm giải thích hay markdown:
[
  {
    "type": "multiple-choice",
    "questionText": "Nội dung câu hỏi",
    "options": [
      {"id": "a", "text": "Nội dung đáp án A"},
      {"id": "b", "text": "Nội dung đáp án B"}
    ],
    "correctAnswerId": "a",  // Điền id của đáp án đúng hoặc chuỗi rỗng nếu không có
    "explanation": "Câu giải thích nếu có trong bài"
  }
]

Nội dung văn bản gốc:
---------
{text}
---------
```

## 6. Xử Lý Các Edge Cases (Trường Hợp Đặc Biệt)
- **Văn bản quá dài:** Một đề thi có thể có 200 câu hỏi. Tương tự logic đang có với tính năng multi-chunk của bạn, bạn vẫn cần chia nhỏ văn bản (chunking) cho `Import Mode`. Mỗi chunk có thể đẩy lên Gemini và sau đó gộp mảng JSON lại với nhau.
- **File không có đáp án:** Đôi khi khách hàng đưa file Excel chỉ có cột Câu hỏi, cột A, B, C, D nhưng quên không có cột đáp án đúng. Mảng trả về từ Gemini sẽ nhận được `correctAnswerId` trống. Phía App cần có UX (UI Badge/Notification) nhắc nhở người dùng: *"Bạn đang có 50 câu hỏi chưa có đáp án đúng, vui lòng cập nhật thủ công"*.
- **Định dạng bảng Excel phức tạp:** Hàm `to_csv()` của Pandas (đang dùng hiện tại ở backend) đã đủ tốt để LLM hình dung cấu trúc dữ liệu theo chiều dọc. Gemini rất giỏi trong việc hiểu CSV để mapping (Cột 1: Câu hỏi | Cột 2-5: Đáp án | Cột 6: Giải thích).
