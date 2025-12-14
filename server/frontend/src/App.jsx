import './App.css';
import DashboardPage from './components/common/DashboardPage';
import AppsPage from './pages/AppsPage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import SupportPage from './pages/SupportPage';
import { Navbar } from './pages/Navbar';
import { Routes, Route, MainLayout } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage/>}/>
      <Route path="/apps" element={<AppsPage/>}/>
      <Route path="/users" element={<UsersPage/>}/>
      <Route path="/settings" element={<SettingsPage/>}/>
      <Route path="/support" element={<SupportPage/>}/>
    </Routes>
  )
}