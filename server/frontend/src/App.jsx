import './App.css';
import MainLayout from './layout/MainLayout';
import DashboardPage from './pages/DashboardPage';
import AppsPage from './pages/AppsPage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import HelpPage from './pages/HelpPage';
import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout/>}>
        <Route path="/" element={<DashboardPage/>}/>
        <Route path="/apps" element={<AppsPage/>}/>
        <Route path="/users" element={<UsersPage/>}/>
        <Route path="/settings" element={<SettingsPage/>}/>
        <Route path="/help" element={<HelpPage/>}/>
      </Route>
    </Routes>
  )
}