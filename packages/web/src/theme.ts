import type { ThemeConfig } from 'antd';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#4c6ef5',
    borderRadius: 8,
    fontSize: 14,
    colorBgLayout: '#f5f6f8',
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#0d1424',
      bodyBg: '#f5f6f8',
      headerHeight: 52,
      headerPadding: '0 20px',
    },
    Menu: {
      darkItemBg: '#0d1424',
      darkItemSelectedBg: '#1d2b4f',
      darkItemColor: '#cbd5e1',
      darkItemSelectedColor: '#ffffff',
    },
  },
};