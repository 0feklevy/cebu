import { HomeSidebar } from '@/components/HomeSidebar';
import { HomeHero } from '@/components/HomeHero';

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh w-full overflow-x-hidden bg-background max-lg:flex-col lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      <HomeSidebar />
      <main className="min-w-0 flex-1 lg:min-h-0 lg:overflow-hidden">
        <HomeHero />
      </main>
    </div>
  );
}
