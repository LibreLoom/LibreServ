import './App.css';
import DashboardPage from './components/common/DashboardPage';
import AppsPage from './components/common/AppsPage';
import UsersPage from './components/common/UsersPage';
import SettingsPage from './components/common/SettingsPage';
import SupportPage from './components/common/SupportPage';
import { Navbar } from './components/common/Navbar';
import { Routes, Route, MainLayout } from 'react-router-dom';

export default function App() {
  return (
    <>
    <Routes>
      <Route path="/" element={<DashboardPage/>}/>
      <Route path="/apps" element={<AppsPage/>}/>
      <Route path="/users" element={<UsersPage/>}/>
      <Route path="/settings" element={<SettingsPage/>}/>
      <Route path="/support" element={<SupportPage/>}/>
    </Routes>
    <Navbar />
    </>
  )
}