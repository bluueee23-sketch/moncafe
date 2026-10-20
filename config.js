/*
 * 친구랑 인터넷으로 같이 앉고 싶을 때만 채워요. (README의 "친구랑 같이 쓰기" 참고)
 * 비워두면 같은 브라우저의 탭끼리만 연결돼요.
 *
 * supabaseAnonKey 는 "공개용(anon / publishable)" 키예요. 웹페이지에 넣어도 되는 키입니다.
 * service_role(비밀) 키는 절대 넣지 마세요.
 */
window.CAFE_CONFIG = {
  supabaseUrl: '',      // 예: 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',  // 예: 'eyJhbGciOi...'
  room: 'main',         // 기본 매장 이름. 주소 뒤 ?room=우리반 으로 바꿀 수 있어요.
};
