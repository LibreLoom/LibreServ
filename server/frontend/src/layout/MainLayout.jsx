import { Outlet } from 'react-router-dom';
import Navbar from '../components/common/Navbar';

export default function MainLayout() {
    return (
        <div className="relative flex flex-col">
            <main className='pb-32 flex-grow w-full'>
                <Outlet/>
            </main>
            <Navbar/>
        </div>
    )
}