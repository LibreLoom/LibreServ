import { Grid2X2, Home, Settings, Users, LifeBuoy } from 'lucide-react';

const navButtonClasses = "flex items-center gap-2 transition-colors px-3 py-1.5 rounded-pill " + 
                         "hover:bg-secondary hover:text-primary"; // Hover Inversion Effect

const dividerClasses = "text-accent text-lg";

export default function Navbar() {
    return (
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 min-w-screen pl-6 pr-6">
            <div className="bg-primary text-secondary border-2 border-accent rounded-pill px-6 py-3">
                <div className="flex items-center gap-6 text-sm font-sans justify-center">

                    <button className={navButtonClasses}>
                        <Home size={18} />
                        <span>Dashboard</span>
                    </button>

                    <span className={dividerClasses}>|</span>

                    <button className={navButtonClasses}>
                        <Grid2X2 size={18} />
                        <span>Apps</span>
                    </button>

                    <span className={dividerClasses}>|</span>

                    <button className={navButtonClasses}>
                        <Users size={18} />
                        <span>Users</span>
                    </button>

                    <span className={dividerClasses}>|</span>

                    <button className={navButtonClasses}>
                        <Settings size={18} />
                        <span>Settings</span>
                    </button>

                    <span className={dividerClasses}>|</span>

                    <button className={navButtonClasses}>
                        <LifeBuoy size={18} />
                        <span>Help</span>
                    </button>

                </div>
            </div>
        </nav>
    );
}
