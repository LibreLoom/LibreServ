import { useNavigate } from "react-router-dom";
import HeaderCard from "../components/cards/HeaderCard";
import Card from "../components/cards/Card";
import AddUserForm from "../components/common/forms/AddUserForm";

export default function AddUserPage() {
  const navigate = useNavigate();

  const handleSuccess = () => {
    navigate("/users");
  };

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="add-user-title"
      id="main-content"
      tabIndex={-1}
    >
      <header className="mb-6">
        <HeaderCard id="add-user-title" title="Add User" />
      </header>

      <Card className="max-w-lg mx-auto">
        <AddUserForm onSuccess={handleSuccess} />
      </Card>
    </main>
  );
}
